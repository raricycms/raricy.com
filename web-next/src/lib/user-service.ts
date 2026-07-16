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
import { hashPassword } from './password';
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

  // 邀请码（可选）：无效直接拒绝；有效则升级为 core
  let role = 'user';
  let inviteRecordId: number | null = null;
  if (inviteCode) {
    if (inviteCode.length !== 12) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    const record = await prisma.inviteCode.findUnique({ where: { code: inviteCode } });
    if (!record || record.isUsed) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    role = 'core';
    inviteRecordId = record.id;
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  // 头像通过 /api/avatar/[id] 按 id 确定性生成，无需落盘文件，故 avatarPath 留空。
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id,
        username,
        email,
        passwordHash,
        role,
        createdAt: new Date(),
        sessionVersion: 0,
      },
    });
    if (inviteRecordId !== null) {
      // 标记邀请码已用（对齐 mark_invite_code_used）
      await tx.inviteCode.update({
        where: { id: inviteRecordId },
        data: { isUsed: true, usedBy: id },
      });
    }
  });

  // TODO(生产): 账户服务小鱼干账户创建（Flask sign_up.py 的 account_client.create_account）
  //             本切片暂不接入账户微服务。

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
