// ─────────────────────────────────────────────────────────────────────────────
// user-service.ts — 用户注册 / 公开资料 / 本人资料更新
//
// 对齐 Flask 侧：
//   • 注册     app/web/auth/sign_up.py（校验用户名/邮箱/密码、邀请码升级为 core）
//   • 公开资料 app/web/auth/profile.py + User.to_public_dict()（绝不含 email）
//   • 资料更新 app/web/auth/settings.py（bio、隐私可见性、通知偏好）
//
// 与其它 service 一致：纯函数 + 显式参数，方便测试与复用。
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { hashPassword, verifyPassword } from './password';
import {
  accountClient,
  accountServiceEnabled,
  encryptApiKey,
  AccountServiceError,
  InviteCodeRaceError,
  assertRemoteRequiredInProduction,
} from './account-client';
import type { Prisma } from '@prisma/client';

// ── 输入校验（对齐 verify_username / verify_email）──────────────────────────

/** 用户名：3-20 位，Unicode 字母/数字/下划线/连字符，且不以 _ - 开头或结尾。 */
export function validateUsername(username: string): { ok: boolean; message: string } {
  if (username.length < 3) return { ok: false, message: '用户名过短（至少3个字符）' };
  if (username.length > 20) return { ok: false, message: '用户名过长（最多20个字符）' };
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
    return { ok: false, message: '用户名含非法字符' };
  }
  if (username.startsWith('-') || username.startsWith('_')) {
    return { ok: false, message: '用户名不能以 _ 或 - 开头' };
  }
  if (username.endsWith('-') || username.endsWith('_')) {
    return { ok: false, message: '用户名不能以 _ 或 - 结尾' };
  }
  return { ok: true, message: 'ok' };
}

/** 邮箱格式（与 Flask verify_email 的正则一致）。 */
export function validateEmail(email: string): boolean {
  return /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]{2,}$/.test(email);
}

// ── 注册 ──────────────────────────────────────────────────────────────────

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  inviteCode?: string | null;
}

export interface RegisterResult {
  ok: boolean;
  code: number;
  message: string;
  user?: { id: string; username: string; role: string; sessionVersion: number };
}

/**
 * 注册新用户。校验顺序对齐 Flask：用户名重复 → 用户名格式 → 邮箱重复 → 邮箱格式 → 长度。
 * 提供有效未用邀请码时升级为 'core' 并把邀请码标记为已用（同一事务内幂等）。
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const username = (input.username || '').trim();
  const email = (input.email || '').trim();
  const password = input.password || '';
  const inviteCode = (input.inviteCode || '').trim();

  if (!username || !email || !password) {
    return { ok: false, code: 400, message: '缺少必要参数' };
  }

  // 用户名重复
  if (await prisma.user.findUnique({ where: { username } })) {
    return { ok: false, code: 400, message: '用户名已存在' };
  }
  // 用户名格式
  const uv = validateUsername(username);
  if (!uv.ok) return { ok: false, code: 400, message: uv.message };

  // 邮箱重复
  if (await prisma.user.findUnique({ where: { email } })) {
    return { ok: false, code: 400, message: '邮箱已存在' };
  }
  // 邮箱格式
  if (!validateEmail(email)) {
    return { ok: false, code: 400, message: '邮箱格式不正确' };
  }
  // 长度限制（对齐 Flask：密码/邮箱 ≤ 100）
  if (password.length > 100) return { ok: false, code: 400, message: '密码过长！' };
  if (email.length > 100) return { ok: false, code: 400, message: '邮箱过长!' };

  // 邀请码（可选）：无效直接拒绝；有效则升级为 core。
  //
  // 这里只做「格式 + 存在性」的预检以便尽早返回错误；**真正的占用是在下方事务里用
  // updateMany(where isUsed:false) 原子完成的**（与 verifyInviteAndUpgrade 同款）。
  // 不能依赖此处的读结果做占用判断 —— 读在事务外，两个并发注册会同时读到 isUsed=false，
  // 若事务内只按 id 无条件 update，一个一次性邀请码就能兑出两个 core（已实测复现）。
  let role = 'user';
  let inviteCodeToClaim: string | null = null;
  if (inviteCode) {
    if (inviteCode.length !== 12) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    const record = await prisma.inviteCode.findUnique({ where: { code: inviteCode } });
    if (!record || record.isUsed) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    role = 'core';
    inviteCodeToClaim = inviteCode;
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  // 远端账户创建是否启用（未配置 internal token → dev 本地模式，见下）。
  const remoteEnabled = accountServiceEnabled();

  // ── 建号（fail-closed，对齐 CLAUDE.md Phase 1.5 写路径）─────────────────────────
  // 本地写入（建用户 + 标记邀请码 + 落 fishApiKeyEncrypted）全部收进一个交互式事务，
  // 并在 **事务提交之前** 调用账户微服务 create_account 同步；远端成功才提交本地，
  // 远端抛错则从事务回调抛出 → Prisma 回滚整个本地事务，绝不出现「本地建了号但远端
  // 没账户」的不一致。远端不可达一律以 AccountServiceError(503) 向调用方返回明确错误。
  //
  // ⚠️ 与 Flask sign_up.py 的差异：Flask 侧 create_account 是 fire-and-forget（失败仅
  //    记 warning、不阻塞注册，靠首次鱼干操作时 _ensure_account_exists 补注册）。本切片
  //    按任务要求 + feed-service.ts 的 fail-closed 约定改为强一致：远端故障即注册失败。
  //
  // 头像通过 /api/avatar/[id] 按 id 确定性生成，无需落盘文件，故 avatarPath 留空。
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.user.create({
          data: {
            id,
            username,
            email,
            passwordHash,
            role,
            createdAt: nowForDb(),
            sessionVersion: 0,
          },
        });
        if (inviteCodeToClaim !== null) {
          // 原子占用邀请码（对齐 mark_invite_code_used，并与 verifyInviteAndUpgrade 同款）：
          // 条件里必须带 isUsed:false —— 并发时只有一个事务能把 count 拿到 1，
          // 另一个拿到 0 并在此抛错回滚，从而杜绝「一码兑两号」。
          const claimed = await tx.inviteCode.updateMany({
            where: { code: inviteCodeToClaim, isUsed: false },
            data: { isUsed: true, usedBy: id },
          });
          if (claimed.count === 0) {
            throw new InviteCodeRaceError();
          }
        }

        // ── 远端同步：★ 提交前 ★ 建小鱼干账户（fail-closed 关键点）────────────────
        // 远端抛错 → 从事务回调抛出 → 回滚整个本地事务。
        if (remoteEnabled) {
          // create_account 幂等：首次创建才返回 api_key，加密后回写用户表。
          const acct = await accountClient.ensureAccount(id);
          if (acct.api_key) {
            await tx.user.update({
              where: { id },
              data: { fishApiKeyEncrypted: encryptApiKey(acct.api_key) },
            });
          }
        } else {
          // 未配置账户服务。
          //
          // 【生产必须 fail-closed】漏配 ACCOUNT_SERVICE_INTERNAL_TOKEN 时若静默放行，
          // 就与 Phase 1.5 的意图完全相反：用户建了号却没有远端鱼干账户，
          // 且只留一条 console.warn，几乎不会被发现。故生产环境直接拒绝。
          assertRemoteRequiredInProduction('注册');
          // 开发环境：仅建本地用户，明确告警。
          // 用户首次投喂时 feed-service 会因缺少 fishApiKeyEncrypted 而 fail-closed。
          console.warn(
            `[user-service] ACCOUNT_SERVICE 未配置，注册仅建本地用户（dev fallback）。user=${id}`
          );
        }
      },
      { timeout: 15000, maxWait: 5000 }
    );
  } catch (e) {
    if (e instanceof InviteCodeRaceError) {
      // 并发抢同一个邀请码，本次没抢到（事务已回滚，未建号、未占码）。
      // 对用户就是「这个码已经被用了」——与串行下的判定一致。
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    if (e instanceof AccountServiceError) {
      // 远端失败：本地事务已回滚，向用户返回明确错误（fail-closed）。
      console.warn(
        `[user-service] 账户服务建号失败，注册本地事务已回滚（user=${id}）: ${e.message}`
      );
      return { ok: false, code: 503, message: '账户服务暂时不可用，注册失败，请稍后重试' };
    }
    // 兜底：其它意外异常按 fail-closed 处理，返回 503（本地事务已回滚）。
    console.error(`[user-service] 注册异常，本地事务已回滚（user=${id}）:`, e);
    return { ok: false, code: 503, message: '注册失败，请稍后重试' };
  }

  let message = '注册成功';
  if (role !== 'user') message += '，您的账号已通过邀请码验证';
  return { ok: true, code: 200, message, user: { id, username, role, sessionVersion: 0 } };
}

// ── 公开资料 ────────────────────────────────────────────────────────────────

export interface PublicProfile {
  id: string;
  username: string;
  avatarPath: string | null;
  bio: string | null;
  createdAt: string | null;
  role: string;
  showRecentBlogs: boolean;
  showRecentComments: boolean;
  recentBlogs: { id: string; title: string; createdAt: string | null; likesCount: number }[];
  recentComments: {
    id: string;
    blogId: string;
    blogTitle: string;
    content: string;
    createdAt: string | null;
  }[];
}

/** 对外公开资料（无 email）。含最近文章/评论，受用户隐私开关控制。不存在返回 null。 */
export async function getPublicProfile(userId: string): Promise<PublicProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      avatarPath: true,
      bio: true,
      createdAt: true,
      role: true,
      showRecentBlogs: true,
      showRecentComments: true,
    },
  });
  if (!user) return null;

  const recentBlogs = user.showRecentBlogs
    ? await prisma.blog.findMany({
        where: { authorId: user.id, ignore: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, createdAt: true, likesCount: true },
      })
    : [];

  const recentComments = user.showRecentComments
    ? await prisma.blogComment.findMany({
        where: { authorId: user.id, isDeleted: false, blog: { ignore: false } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          blogId: true,
          content: true,
          createdAt: true,
          blog: { select: { title: true } },
        },
      })
    : [];

  return {
    id: user.id,
    username: user.username,
    avatarPath: user.avatarPath,
    bio: user.bio,
    createdAt: user.createdAt ? user.createdAt.toISOString() : null,
    role: user.role,
    showRecentBlogs: user.showRecentBlogs,
    showRecentComments: user.showRecentComments,
    recentBlogs: recentBlogs.map((b) => ({
      id: b.id,
      title: b.title,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      likesCount: b.likesCount ?? 0,
    })),
    recentComments: recentComments.map((c) => ({
      id: c.id,
      blogId: c.blogId,
      blogTitle: c.blog?.title ?? '',
      content: (c.content ?? '').slice(0, 120),
      createdAt: c.createdAt ? c.createdAt.toISOString() : null,
    })),
  };
}

// ── 本人资料更新 ──────────────────────────────────────────────────────────────

export interface ProfilePatch {
  bio?: string | null;
  notifyLike?: boolean;
  notifyEdit?: boolean;
  notifyDelete?: boolean;
  notifyAdmin?: boolean;
  showRecentBlogs?: boolean;
  showRecentComments?: boolean;
}

export interface UpdateResult {
  ok: boolean;
  code: number;
  message: string;
  data?: ProfilePatch;
}

/** 更新本人资料（仅传入的字段）。bio ≤ 500 字，超长拒绝（对齐 update_bio）。 */
export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UpdateResult> {
  const data: Prisma.UserUpdateInput = {};

  if ('bio' in patch) {
    const bio = (patch.bio ?? '').toString().trim();
    if (bio.length > 500) {
      return { ok: false, code: 400, message: '个人简介不能超过 500 字' };
    }
    data.bio = bio ? bio : null;
  }
  if (typeof patch.notifyLike === 'boolean') data.notifyLike = patch.notifyLike;
  if (typeof patch.notifyEdit === 'boolean') data.notifyEdit = patch.notifyEdit;
  if (typeof patch.notifyDelete === 'boolean') data.notifyDelete = patch.notifyDelete;
  if (typeof patch.notifyAdmin === 'boolean') data.notifyAdmin = patch.notifyAdmin;
  if (typeof patch.showRecentBlogs === 'boolean') data.showRecentBlogs = patch.showRecentBlogs;
  if (typeof patch.showRecentComments === 'boolean') {
    data.showRecentComments = patch.showRecentComments;
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, code: 400, message: '没有可更新的字段' };
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      bio: true,
      notifyLike: true,
      notifyEdit: true,
      notifyDelete: true,
      notifyAdmin: true,
      showRecentBlogs: true,
      showRecentComments: true,
    },
  });

  return {
    ok: true,
    code: 200,
    message: '资料已保存',
    data: {
      bio: updated.bio,
      notifyLike: updated.notifyLike ?? true,
      notifyEdit: updated.notifyEdit ?? true,
      notifyDelete: updated.notifyDelete ?? true,
      notifyAdmin: updated.notifyAdmin ?? true,
      showRecentBlogs: updated.showRecentBlogs,
      showRecentComments: updated.showRecentComments,
    },
  };
}

// ── 修改密码 ──────────────────────────────────────────────────────────────────

export interface ChangePasswordResult {
  ok: boolean;
  code: number;
  message: string;
}

/**
 * 修改本人密码，逐条对齐 Flask auth.change_password 的校验顺序与文案：
 *   1. 三项必填            → '请填写完整的信息'
 *   2. 原密码校验失败      → '原密码不正确'
 *   3. 新密码两次不一致    → '两次输入的新密码不一致'
 *   4. 新密码长度 < 8      → '新密码长度至少为 8 位'
 *   5. 新旧密码相同        → '新密码不能与原密码相同'
 * 成功后重写哈希并 **自增 session_version**（对齐 Flask：使所有旧会话失效）。
 * 调用方（route）负责随后清除当前会话 cookie（等价 Flask 的 logout_user）。
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
): Promise<ChangePasswordResult> {
  const cur = (currentPassword || '').trim();
  const next = (newPassword || '').trim();
  const confirm = (confirmPassword || '').trim();

  if (!cur || !next || !confirm) {
    return { ok: false, code: 400, message: '请填写完整的信息' };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, sessionVersion: true },
  });
  if (!user) return { ok: false, code: 401, message: '未登录' };

  if (!(await verifyPassword(cur, user.passwordHash))) {
    return { ok: false, code: 400, message: '原密码不正确' };
  }
  if (next !== confirm) {
    return { ok: false, code: 400, message: '两次输入的新密码不一致' };
  }
  if (next.length < 8) {
    return { ok: false, code: 400, message: '新密码长度至少为 8 位' };
  }
  if (cur === next) {
    return { ok: false, code: 400, message: '新密码不能与原密码相同' };
  }

  const passwordHash = await hashPassword(next);
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      sessionVersion: (user.sessionVersion ?? 0) + 1,
    },
  });

  return { ok: true, code: 200, message: '密码修改成功，请使用新密码重新登录。' };
}

// ── 邀请码验证 + 角色升级 ─────────────────────────────────────────────────────

export interface AuthenticResult {
  ok: boolean;
  code: number;
  message: string;
}

/**
 * 邀请码验证，对齐 Flask auth.authentic（POST）：
 *   • verify_invite_code：长度必须为 12，且邀请码存在且未被使用；否则 '邀请码无效'
 *   • mark_invite_code_used：标记 is_used / used_by（这里用 updateMany + isUsed:false 兜住并发）
 *   • 角色升级：仅当当前仍为普通用户（role == 'user'）时升级为 'core'
 */
export async function verifyInviteAndUpgrade(userId: string, code: string): Promise<AuthenticResult> {
  // 对齐 verify_invite_code：长度必须恰为 12
  if (code.length !== 12) {
    return { ok: false, code: 400, message: '邀请码无效' };
  }

  const record = await prisma.inviteCode.findUnique({ where: { code } });
  if (!record || record.isUsed) {
    return { ok: false, code: 400, message: '邀请码无效' };
  }

  // 标记已用（并发安全：仅当仍未使用时才成功）
  const marked = await prisma.inviteCode.updateMany({
    where: { code, isUsed: false },
    data: { isUsed: true, usedBy: userId },
  });
  if (marked.count === 0) {
    return { ok: false, code: 400, message: '邀请码无效' };
  }

  // 仅当仍为普通用户时升级为核心用户（对齐 Flask 的 role == 'user' 判定）
  await prisma.user.updateMany({
    where: { id: userId, role: 'user' },
    data: { role: 'core' },
  });

  return { ok: true, code: 200, message: '验证成功' };
}
