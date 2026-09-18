// ─────────────────────────────────────────────────────────────────────────────
// user-service.ts — 用户注册 / 公开资料 / 本人资料更新
//
// 三块职责：
//   • 注册     校验用户名/邮箱/密码、邀请码升级为 core
//   • 公开资料 对外序列化（**绝不含 email**）
//   • 资料更新 bio、隐私可见性、通知偏好
//
// 与其它 service 一致：纯函数 + 显式参数，方便测试与复用。
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { hashPassword, verifyPassword } from './password';
import { kickUser } from './chat-bus';
import { publishToUser } from './topbar-bus';
import {
  accountServiceEnabled,
  AccountServiceError,
  InviteCodeRaceError,
  assertRemoteRequiredInProduction,
} from './account-client';
import {
  recordPendingSync,
  settleSync,
  executeSync,
  logReconcileRequired,
} from './fish-sync';
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

/** 邮箱格式（正则不要改：存量用户的邮箱都是按它校验进来的）。 */
export function validateEmail(email: string): boolean {
  return /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]{2,}$/.test(email);
}

// ── 占位邮箱（站长建号留空时由系统合成）──────────────────────────────────────

/**
 * 占位邮箱的保留域名。`.invalid` 是 RFC 2606 保留的不可解析 TLD —— 永不投递，
 * 因此不可能与任何真实邮箱冲突；用户名本身唯一 ⇒ 合成出来的邮箱也唯一。
 */
export const PLACEHOLDER_EMAIL_DOMAIN = 'users.invalid';

/**
 * 由用户名合成占位邮箱。
 *
 * ⚠️ 返回值**不要**再拿去跑 `validateEmail`：那个正则的 local part 只允许
 * `[a-zA-Z0-9_.+-]`，而 `validateUsername` 明确放行 Unicode 字母（`张三-李四` 是合法
 * 用户名，有测试钉着）—— 拿它校验合成值会让中文用户名全部建不出号。合成值是机器
 * 生成的：唯一性由 username 的唯一约束保证，投递性由 `.invalid` 永不解析保证。
 */
export function buildPlaceholderEmail(username: string): string {
  return `${username}@${PLACEHOLDER_EMAIL_DOMAIN}`;
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
 * 注册新用户。校验顺序（tests/service/user-service.test.ts 逐条钉着）：
 * 用户名重复 → 用户名格式 → 邮箱重复 → 邮箱格式 → 长度。
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
  // 长度限制：密码/邮箱 ≤ 100
  if (password.length > 100) return { ok: false, code: 400, message: '密码过长！' };
  if (email.length > 100) return { ok: false, code: 400, message: '邮箱过长!' };

  // 占位邮箱的保留域不接受公开注册：否则任何人都能抢注 `bob@users.invalid`，
  // 让站长之后没法给一个叫 bob 的人用空邮箱建号（email 唯一约束）。
  // ⚠️ 位置必须在长度检查之后 —— 前面每一步的先后顺序都被
  // tests/service/user-service.test.ts 钉着。文案复用「格式不正确」，不泄漏保留域的存在。
  if (email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)) {
    return { ok: false, code: 400, message: '邮箱格式不正确' };
  }

  // 邀请码（可选）：无效直接拒绝；有效则升级为 core。
  //
  // 这里只做「格式 + 存在性」的预检以便尽早返回错误；**真正的占用是在下方事务里用
  // updateMany(where isUsed:false) 原子完成的**（与 verifyInviteAndUpgrade 同款）。
  // 不能依赖此处的读结果做占用判断 —— 读在事务外，两个并发注册会同时读到 isUsed=false，
  // 若事务内只按 id 无条件 update，一个一次性邀请码就能兑出两个 core（已实测复现）。
  let role = 'user';
  // 邀请码的原子占用与补偿释放都通过回调交给内核执行 —— 内核里因此没有一行邀请码语义。
  // 收成常量是因为闭包里 TS 不保留对 let 的收窄。
  let hooks:
    | {
        beforeCommit: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
        onCompensate: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
      }
    | undefined;
  if (inviteCode) {
    if (inviteCode.length !== 12) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    const record = await prisma.inviteCode.findUnique({ where: { code: inviteCode } });
    if (!record || record.isUsed) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    role = 'core';
    const code = inviteCode;
    hooks = {
      // 原子占用邀请码（对齐 mark_invite_code_used，并与 verifyInviteAndUpgrade 同款）：
      // 条件里必须带 isUsed:false —— 并发时只有一个事务能把 count 拿到 1，
      // 另一个拿到 0 并在此抛错回滚，从而杜绝「一码兑两号」。
      beforeCommit: async (tx, userId) => {
        const claimed = await tx.inviteCode.updateMany({
          where: { code, isUsed: false },
          data: { isUsed: true, usedBy: userId },
        });
        if (claimed.count === 0) {
          throw new InviteCodeRaceError();
        }
      },
      // 远端建账户失败时的补偿：把码放回去（在删用户之前执行，与原先的语句顺序一致）
      onCompensate: async (tx, userId) => {
        await tx.inviteCode.updateMany({
          where: { code, usedBy: userId },
          data: { isUsed: false, usedBy: null },
        });
      },
    };
  }

  const r = await createUserAccount({
    username,
    email,
    password,
    role,
    remoteRequiredLabel: '注册',
    ...hooks,
  });

  if (!r.ok) {
    if (r.failure.kind === 'precondition') {
      // 并发抢同一个邀请码，本次没抢到（事务已回滚，未建号、未占码）。
      // 对用户就是「这个码已经被用了」——与串行下的判定一致。
      if (r.failure.cause instanceof InviteCodeRaceError) {
        return { ok: false, code: 400, message: '邀请码错误' };
      }
      // 不认识的预检异常：按 fail-closed 兜底（本地事务已回滚）。
      console.error('[user-service] 注册预检异常:', r.failure.cause);
      return { ok: false, code: 503, message: '注册失败，请稍后重试' };
    }
    return { ok: false, ...mapCreateFailure(r.failure, '注册') };
  }

  let message = '注册成功';
  // 尾缀判「本次是否用了邀请码」，不判 role —— 内核的 role 现在也可能来自站长建号入口。
  if (hooks) message += '，您的账号已通过邀请码验证';
  return { ok: true, code: 200, message, user: { id: r.id, username, role: r.role, sessionVersion: 0 } };
}

// ── 建号内核（公开注册 / 站长建号共用）────────────────────────────────────────
//
// 校验**不在这里**：两个入口各有各的校验（公开注册还有邀请码预检），内核只接受
// 已经校验完毕的输入。文案也不在这里：内核只回报结构化的失败原因，措辞留给调用方。

/** 内核的失败原因。 */
export type CreateAccountFailure =
  | { kind: 'unique_violation'; field: 'username' | 'email' | 'unknown' }
  | { kind: 'account_service_down' }
  /** `beforeCommit` 回调抛出的错误——调用方自己的语义，内核不认识。 */
  | { kind: 'precondition'; cause: unknown }
  | { kind: 'unexpected' };

export type CreateAccountResult =
  | { ok: true; id: string; username: string; role: string; sessionVersion: number }
  | { ok: false; failure: CreateAccountFailure };

/** `tx.user.create` 唯一约束冲突的哨兵。只在这一句上判——账本行的 idempotencyKey 也是
 *  unique，若在外层 catch 里做全量 P2002 判定，会把它的冲突也误报成「用户名已存在」。 */
class UserUniqueViolationError extends Error {}

/** `beforeCommit` 回调抛错的包装，用于把它和内核自身的异常区分开。 */
class PreconditionError extends Error {
  constructor(readonly cause: unknown) {
    super('precondition failed');
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002';
}

/**
 * 建号 + 远端鱼干账户同步（fail-closed，对齐 CLAUDE.md「鱼干写路径」）。
 *
 * 远端 HTTP 调用不在 SQLite 事务内（写锁占用问题，见 fish-sync.ts）：
 *   Tx A：建用户 +（调用方的 beforeCommit）+ 账本行 pending → 提交；
 *   Phase 2：ensureAccount（幂等）→ 成功则回写 fishApiKeyEncrypted + 账本标 synced；
 *   失败 → 补偿事务：删用户 + 调用方的回滚由 beforeCommit 的事务语义一并撤销 + 删账本行。
 *
 * ⚠️ 【有意偏离旧版】旧版建号是 fire-and-forget（失败仅记 warning、不阻塞注册，
 *    靠首次鱼干操作时补注册）。这里按 fail-closed 约定改为强一致：
 *    远端故障即建号失败。
 *
 * 头像通过 /api/avatar/[id] 按 id 确定性生成，无需落盘文件，故 avatarPath 留空。
 */
export async function createUserAccount(input: {
  username: string;
  email: string;
  password: string;
  role: string;
  /** 未配置账户服务时的操作名，进日志：'注册' / '建号'。 */
  remoteRequiredLabel: string;
  /** `user.create` 之后、事务提交之前执行；抛错即整个事务回滚，错误以
   *  `{kind:'precondition'}` 的形式回报给调用方。 */
  beforeCommit?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
  /** 远端建账户失败时，在补偿事务里撤销 `beforeCommit` 改过的子状态（如释放邀请码）。
   *  只在传了 beforeCommit 时才需要；无 beforeCommit 的调用方不用传。 */
  onCompensate?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
}): Promise<CreateAccountResult> {
  const { username, email, password, role, remoteRequiredLabel, beforeCommit, onCompensate } =
    input;

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  const entry = {
    idempotencyKey: `register-${id}`,
    operation: 'register' as const,
    payload: { userId: id },
  };

  try {
    // 远端账户创建是否启用（未配置 internal token → dev 本地模式，见下）。
    //
    // ⚠️ assertRemoteRequiredInProduction 必须待在这个 try 里：生产环境漏配 token 时它抛
    // AccountServiceError，落在 try 外会穿透调用方 → Next 返回 500 而不是约定的 503。
    const remoteEnabled = accountServiceEnabled();
    if (!remoteEnabled) {
      assertRemoteRequiredInProduction(remoteRequiredLabel);
      console.warn(
        `[user-service] ACCOUNT_SERVICE 未配置，${remoteRequiredLabel}仅建本地用户（dev fallback）。user=${id}`
      );
    }

    await prisma.$transaction(async (tx) => {
      try {
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
      } catch (e) {
        if (isUniqueViolation(e)) throw new UserUniqueViolationError();
        throw e;
      }

      if (beforeCommit) {
        try {
          await beforeCommit(tx, id);
        } catch (e) {
          throw new PreconditionError(e);
        }
      }

      // 账本登记 pending（远端启用时）
      if (remoteEnabled) {
        await recordPendingSync(tx, entry);
      }
    });

    // ── Phase 2：事务外远端建账户（create_account 幂等）────────────────────────
    if (remoteEnabled) {
      try {
        await executeSync(entry);
        await settleSync(entry.idempotencyKey, 'synced');
      } catch (syncErr) {
        // Phase 3：补偿 —— 删用户 + 删账本行（调用方在 beforeCommit 里改过的东西，
        // 由它自己在事务回滚语义下一起撤销：下游的补偿语句保持原样）。
        try {
          await prisma.$transaction(async (tx) => {
            // 顺序与原先一致：先撤销调用方在 beforeCommit 里改的子状态，再删用户、
            // 最后删账本行。
            if (onCompensate) await onCompensate(tx, id);
            await tx.user.delete({ where: { id } });
            await tx.accountSyncLedger.deleteMany({
              where: { idempotencyKey: entry.idempotencyKey },
            });
          });
        } catch (undoErr) {
          await settleSync(entry.idempotencyKey, 'failed', String(undoErr)).catch(() => {
            /* 尽力而为 */
          });
          await logReconcileRequired(entry, undoErr);
        }
        console.warn(
          `[user-service] 账户服务建号失败，${remoteRequiredLabel}本地写入已补偿回滚（user=${id}）: ` +
            (syncErr instanceof Error ? syncErr.message : String(syncErr))
        );
        return { ok: false, failure: { kind: 'account_service_down' } };
      }
    }
  } catch (e) {
    if (e instanceof UserUniqueViolationError) {
      // 事务已回滚。回读定位到底是哪个字段冲突——不依赖 e.meta.target，那在 SQLite 下
      // 是驱动实现细节（有时是字符串、有时是数组）。顺序与调用方的预检一致：用户名优先。
      if (await prisma.user.findUnique({ where: { username } })) {
        return { ok: false, failure: { kind: 'unique_violation', field: 'username' } };
      }
      if (await prisma.user.findUnique({ where: { email } })) {
        return { ok: false, failure: { kind: 'unique_violation', field: 'email' } };
      }
      // 对手方也回滚了，问不出来是谁占的。
      return { ok: false, failure: { kind: 'unique_violation', field: 'unknown' } };
    }
    if (e instanceof PreconditionError) {
      return { ok: false, failure: { kind: 'precondition', cause: e.cause } };
    }
    if (e instanceof AccountServiceError) {
      // assertRemoteRequiredInProduction 抛的（生产漏配 internal token）——按约定报 503。
      console.error(`[user-service] ${remoteRequiredLabel}被拒（账户服务未就绪）:`, e.message);
      return { ok: false, failure: { kind: 'account_service_down' } };
    }
    // 兜底：意外异常按 fail-closed 处理（本地事务已回滚）。
    console.error(`[user-service] ${remoteRequiredLabel}异常（user=${id}）:`, e);
    return { ok: false, failure: { kind: 'unexpected' } };
  }

  return { ok: true, id, username, role, sessionVersion: 0 };
}

/**
 * 内核失败原因 → 面向用户的 {code, message}。`what` 只影响文案（'注册' / '建号'）。
 * `precondition` 不在其中：那是调用方自己经 beforeCommit 抛出的语义，由调用方处理。
 */
export function mapCreateFailure(
  failure: Exclude<CreateAccountFailure, { kind: 'precondition' }>,
  what: string
): { code: number; message: string } {
  switch (failure.kind) {
    case 'unique_violation':
      return {
        code: 400,
        message:
          failure.field === 'email'
            ? '邮箱已存在'
            : failure.field === 'username'
              ? '用户名已存在'
              : '用户名或邮箱已存在',
      };
    case 'account_service_down':
      return { code: 503, message: `账户服务暂时不可用，${what}失败，请稍后重试` };
    case 'unexpected':
      return { code: 503, message: `${what}失败，请稍后重试` };
  }
}

// ── 公开资料 ────────────────────────────────────────────────────────────────

/** 查看者。`null` = 游客（未登录），**不是**「不判」。 */
export interface ProfileViewer {
  id: string;
  isCore: boolean;
}

export interface PublicProfile {
  id: string;
  username: string;
  avatarPath: string | null;
  bio: string | null;
  createdAt: string | null;
  /** 档位不足时**为 null** —— 别拿它当「一定有」。渲染前必须挡空。 */
  role: string | null;
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

/**
 * 对外公开资料（无 email）。**内容按查看者分档**，不存在返回 null。
 *
 * 【为什么不给 viewer 默认值】照 `clipboard-service.getClip` 的纪律：**默认放行的参数
 * 一旦漏传就是越权**。所以 viewer 必传 —— 调用方要么给 `null`（游客），要么把登录态
 * 显式算出来传进来，不能靠「不写就自动放行」。
 *
 * 【分档口径】`/u/:id` 是**匿名可达**的页面（主页画报的二维码会把站外人引到这里），
 * 所以 profile 里能对游客露什么必须逐项想清楚：
 *   · 一律可见：username / avatarPath / bio / createdAt + 两个开关的当前值（那是页面的主体）
 *   · 仅本人或 core+ 可见：role 徽章、recentBlogs、recentComments
 * 后者三项此前对全互联网开着 —— 而「最后登录时间」还不在本函数里，由 `src/app/u/[id]/page.tsx`
 * 单独查，同样要按查看者收（连同统计行的计数与文章/评论标签区）。
 *
 * 注意两个开关（showRecentBlogs / showRecentComments）**照旧生效**，它们管的是「本人
 * 愿不愿意展示」，与「查看者够不够格」是两个正交的问题：两边都放行才看得见。
 */
export async function getPublicProfile(
  userId: string,
  viewer: ProfileViewer | null
): Promise<PublicProfile | null> {
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

  // 本人看自己永远放行（否则「我的主页」会因为我只是 role=user 就变空壳）；
  // 其余人按档位：core+ 放行，游客与非 core 只拿到上面那几项身份字段。
  const isSelf = viewer?.id === user.id;
  const canSeeContent = isSelf || viewer?.isCore === true;

  const recentBlogs = canSeeContent && user.showRecentBlogs
    ? await prisma.blog.findMany({
        where: { authorId: user.id, ignore: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, createdAt: true, likesCount: true },
      })
    : [];

  const recentComments = canSeeContent && user.showRecentComments
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
    role: canSeeContent ? user.role : null,
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
  /** 专注模式（账号级浏览偏好，见 schema User.focusMode） */
  focusMode?: boolean;
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
  if (typeof patch.focusMode === 'boolean') data.focusMode = patch.focusMode;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: 400, message: '没有可更新的字段' };
  }

  // 文案按本次实际改了什么来选（两句话都沿用既有措辞，别改）：
  // 只动隐私/通知开关 → 「隐私设置已保存」；只要动了 bio → 「资料已保存」。
  const touchedBio = 'bio' in data;
  const savedMessage = touchedBio ? '资料已保存' : '隐私设置已保存';

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
      focusMode: true,
    },
  });

  // 专注模式变更 → 踢掉已建立的 SSE 连接：重连时按新值决定是否接收大区推送
  // （chat-bus 按连接建立时的 focusMode 过滤大区广播）。
  if ('focusMode' in data) {
    kickUser(userId);
    // 顶栏红点同样受专注模式影响（开启后大区不计入汇总）。这里**不踢顶栏流**：
    // 会话没废，铃铛照常要收推送。推送值分两种（够不着 chat-service，会成环，
    // 见 topbar-bus 的 TopbarPatch）：开启 → 大区不计 → 必为 false，推精确值；
    // 关闭 → 大区里可能还压着 @ 我的未读，推「重算」让客户端走 count 路由。
    publishToUser(userId, updated.focusMode ? { chatUnread: false } : { refresh: true });
  }

  return {
    ok: true,
    code: 200,
    message: savedMessage,
    data: {
      bio: updated.bio,
      notifyLike: updated.notifyLike ?? true,
      notifyEdit: updated.notifyEdit ?? true,
      notifyDelete: updated.notifyDelete ?? true,
      notifyAdmin: updated.notifyAdmin ?? true,
      showRecentBlogs: updated.showRecentBlogs,
      showRecentComments: updated.showRecentComments,
      focusMode: updated.focusMode,
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
 * 修改本人密码。以下校验顺序与文案是既有契约
 * （tests/service/user-service.test.ts 逐条钉着，勿改）：
 *   1. 三项必填            → '请填写完整的信息'
 *   2. 原密码校验失败      → '原密码不正确'
 *   3. 新密码两次不一致    → '两次输入的新密码不一致'
 *   4. 新密码长度 < 8      → '新密码长度至少为 8 位'
 *   5. 新旧密码相同        → '新密码不能与原密码相同'
 * 成功后重写哈希并 **自增 session_version**（使所有旧会话失效）。
 * 调用方（route）负责随后清除当前会话 cookie（清掉本机这一个，其余靠上面的自增）。
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
 * 邀请码验证：
 *   • 校验：长度必须为 12，且邀请码存在且未被使用；否则 '邀请码无效'
 *   • 标记已用：写 isUsed / usedBy（用 updateMany + isUsed:false 兜住并发）
 *   • 角色升级：仅当当前仍为普通用户（role === 'user'）时升级为 'core'
 */
export async function verifyInviteAndUpgrade(userId: string, code: string): Promise<AuthenticResult> {
  // 长度必须恰为 12（生成侧恒产 12 位，见 invite-code.ts）
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

  // 仅当仍为普通用户（role === 'user'）时升级为核心用户：管理员/站长不会被降级
  await prisma.user.updateMany({
    where: { id: userId, role: 'user' },
    data: { role: 'core' },
  });

  return { ok: true, code: 200, message: '验证成功' };
}
