// ─────────────────────────────────────────────────────────────────────────────
// account-service.ts — 账号 / 凭据事实：注册建号、邀请码核销与升级、改密。
//
// 从 user-service.ts 按状态所有权拆出（依据 reports/round3/notes/impl-split.md §3.2 B2）：
//   · 本文件唯一负责的事实：`users.password_hash`、`users.role`（邀请码升级）、
//     `users.session_version`（改密/失效）、`InviteCode.isUsed/usedBy`（核销）；
//   · 公开资料与本人资料（bio / 隐私 / 通知偏好 / 专注屏蔽）仍在 user-service.ts。
// 两边的列不重叠、依赖集不相交；`admin-user-service` 的站长建号复用这里的建号内核。
//
// 与其它 service 一致：纯函数 + 显式参数，方便测试与复用。
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { hashPassword, verifyPassword } from './password';
import { allowPasswordAttempt } from './password-budget';
import { kickUser } from './chat-bus';
import { kickTopbarUser } from './topbar-bus';
import { INVITE_CODE_LENGTH } from './invite-code';
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

/**
 * 并发抢同一个邀请码时**没抢到**的那一方（不是系统错误，是一次正常的落败）。
 *
 * 由 `registerUser` 的 `beforeCommit` 在事务内抛出：条件写 `isUsed:false` 没拿到 1 行
 * ⇒ 另一个事务已经兑走了这个码 ⇒ 抛错让整笔事务回滚（未建号、未占码）。内核把它原样
 * 以 `{kind:'precondition'}` 交回调用方，`registerUser` 再认出来翻译成「邀请码错误」。
 */
export class InviteCodeRaceError extends Error {
  constructor() {
    super('邀请码已被占用');
    this.name = 'InviteCodeRaceError';
  }
}

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
 * 必须提供有效未用邀请码，直接创建 core 并在同一事务中原子占码。
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

  if (!inviteCode) return { ok: false, code: 400, message: '请填写邀请码' };

  // 邀请码必填：预检不代替事务内的原子占用。
  //
  // 这里只做「格式 + 存在性」的预检以便尽早返回错误；**真正的占用是在下方事务里用
  // updateMany(where isUsed:false) 原子完成的**（与 verifyInviteAndUpgrade 同款）。
  // 不能依赖此处的读结果做占用判断 —— 读在事务外，两个并发注册会同时读到 isUsed=false，
  // 若事务内只按 id 无条件 update，一个一次性邀请码就能兑出两个 core（已实测复现）。
  const role = 'core';
  // 邀请码的原子占用通过回调交给内核执行 —— 内核里因此没有一行邀请码语义。
  // 收成常量是因为闭包里 TS 不保留对 let 的收窄。
  // 【为什么不需要「撤销」回调】占用与建号在**同一个事务**里：回调抛错（被另一个并发
  // 注册抢先）或建号失败，整个事务一起回滚，码自己就回到未用状态 —— 不存在「占用了
  // 但号没建成」的中间态，也就没有要单独撤销的东西。
  let beforeCommit: ((tx: Prisma.TransactionClient, userId: string) => Promise<void>) | undefined;
  if (inviteCode) {
    if (inviteCode.length !== INVITE_CODE_LENGTH) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    const record = await prisma.inviteCode.findUnique({ where: { code: inviteCode } });
    if (!record || record.isUsed) {
      return { ok: false, code: 400, message: '邀请码错误' };
    }
    const code = inviteCode;
    // 原子占用邀请码（与 verifyInviteAndUpgrade 同款）：
    // 条件里必须带 isUsed:false —— 并发时只有一个事务能把 count 拿到 1，
    // 另一个拿到 0 并在此抛错回滚，从而杜绝「一码兑两号」。
    beforeCommit = async (tx, userId) => {
      const claimed = await tx.inviteCode.updateMany({
        where: { code, isUsed: false },
        data: { isUsed: true, usedBy: userId },
      });
      if (claimed.count === 0) {
        throw new InviteCodeRaceError();
      }
    };
  }

  const r = await createUserAccount({
    username,
    email,
    password,
    role,
    remoteRequiredLabel: '注册',
    beforeCommit,
  });

  if (!r.ok) {
    if (r.failure.kind === 'precondition') {
      // 并发抢同一个邀请码，本次没抢到（事务已回滚，未建号、未占码）。
      // 对用户就是「这个码已经被用了」——与串行下的判定一致。
      if (r.failure.cause instanceof InviteCodeRaceError) {
        return { ok: false, code: 400, message: '邀请码错误' };
      }
      // 不认识的预检异常：本地事务已回滚（未建号、未占码），按拒绝兜底。
      console.error('[account-service] 注册预检异常:', r.failure.cause);
      return { ok: false, code: 503, message: '注册失败，请稍后重试' };
    }
    return { ok: false, ...mapCreateFailure(r.failure, '注册') };
  }

  return { ok: true, code: 200, message: '注册成功', user: { id: r.id, username, role: r.role, sessionVersion: 0 } };
}

// ── 建号内核（公开注册 / 站长建号共用）────────────────────────────────────────
//
// 校验**不在这里**：两个入口各有各的校验（公开注册还有邀请码预检），内核只接受
// 已经校验完毕的输入。文案也不在这里：内核只回报结构化的失败原因，措辞留给调用方。

/** 内核的失败原因。 */
export type CreateAccountFailure =
  | { kind: 'unique_violation'; field: 'username' | 'email' | 'unknown' }
  /** `beforeCommit` 回调抛出的错误——调用方自己的语义，内核不认识。 */
  | { kind: 'precondition'; cause: unknown }
  | { kind: 'unexpected' };

export type CreateAccountResult =
  | { ok: true; id: string; username: string; role: string; sessionVersion: number }
  | { ok: false; failure: CreateAccountFailure };

/** `tx.user.create` 唯一约束冲突的哨兵。只在这一句上判——在外层 catch 里做全量 P2002
 *  判定的话，事务内**其它**写入（调用方 beforeCommit 改的子表）撞上的唯一约束也会被
 *  误报成「用户名已存在」。 */
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
 * 建号内核：**一个本地事务**建 users 行（公开注册 / 站长建号共用）。
 *
 * 建号就是这一件事，没有第二个参与者：用户行写进 SQLite 即完成，不存在
 * 「本地已建、别处还没建」的窗口，因此也没有补偿事务。
 *
 * 头像通过 /api/avatar/[id] 按 id 确定性生成，无需落盘文件，故 avatarPath 留空。
 */
export async function createUserAccount(input: {
  username: string;
  email: string;
  password: string;
  role: string;
  /** 操作名，只用于日志文案：'注册' / '建号'。 */
  remoteRequiredLabel: string;
  /** `user.create` 之后、事务提交之前执行；抛错即整个事务回滚（用户行与回调改过的
   *  子状态一起撤销），错误以 `{kind:'precondition'}` 的形式回报给调用方。 */
  beforeCommit?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
}): Promise<CreateAccountResult> {
  const { username, email, password, role, remoteRequiredLabel, beforeCommit } = input;

  const id = randomUUID();
  const passwordHash = await hashPassword(password);

  try {
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
    });
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
    // 兜底：意外异常按拒绝处理（本地事务已回滚，没建号）。
    console.error(`[account-service] ${remoteRequiredLabel}异常（user=${id}）:`, e);
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
    case 'unexpected':
      return { code: 503, message: `${what}失败，请稍后重试` };
  }
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
 * 成功后重写哈希、原子自增 session_version，并断开两条已认证的 SSE（使旧会话立即失效）。
 * 调用方（route）负责随后清除当前会话 cookie（清掉本机这一个，其余靠上面的自增）。
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
  ip?: string
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

  if (!allowPasswordAttempt(`user:${userId}`, ip)) {
    return { ok: false, code: 429, message: '密码校验过于频繁，请稍后再试' };
  }
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
      sessionVersion: { increment: 1 },
    },
  });

  kickUser(userId);
  kickTopbarUser(userId);

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
  // 长度必须恰为 INVITE_CODE_LENGTH（生成侧恒产 12 位，见 invite-code.ts 的常量）
  if (code.length !== INVITE_CODE_LENGTH) {
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
