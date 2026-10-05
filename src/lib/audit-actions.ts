// ─────────────────────────────────────────────────────────────────────────────
// audit-actions.ts — 管理操作日志的**动作词汇表**（20 个码的中文名、分组、配色档、metadata 说法）
//
// 【为什么单独一个文件】动作码在几处被渲染成界面文案，而它们此前**各抄了一份**：
//   · 公示页的筛选下拉只认 4 个码
//   · 申诉管理页有一张只认 5 个码的 ACTION_LABELS
//   · 公示页与详情页干脆把 `log.action` 原样印出来
// 而写进 `admin_action_logs` 的一共有 **20 个码**（散在 8 个 service + CLI 的裸字面量里）。
// 每次新增一个动作，上面每一份副本都**静默漏一个** —— 不报错，只是那一类从此在界面上
// 显示成英文机器码，或者在筛选器里根本选不到。这正是「日志页面分类不全」的根。
//
// 为什么不把表放进 `audit-service.ts`（它才是这套东西的自然归宿）：那个文件拖着 prisma，
// **不能进客户端包**；而筛选下拉是构建在页面里的（今天是服务端表单，但动作码同样要被
// 客户端组件用到处引用）。`import type` 帮不上忙 —— 它只擦类型，擦不掉运行时数组。
// 所以词汇必须住在一个零依赖模块里：本文件只 `import` 零依赖的 `./format`。
//
// 表一律用 `Record<AuditAction, …>`（穷尽类型）：加第 21 个码时，凡是忘了登记的表
// **当场 tsc 报错**，而不是界面上少一枚 chip。
// 唯一真相源是 `AUDIT_ACTIONS`；`tests/unit/audit-action-guard.test.ts` 静态盯着
// 「写侧用了、表里没有」与「表里有、写侧没人用」两个方向。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from './format';

/**
 * 20 个动作码。**这个顺序就是筛选下拉里的顺序**（按 group 分块），别打乱。
 *
 * 别在这里删码：`AUDIT_ACTIONS` 是解析白名单，删掉一个码会让历史日志里的那一类
 * 在筛选时被判成「非法值」（`parseAction` 返回 null）。要退役某个动作，
 * 让它继续留在表里，只是不再有新的写入方。
 */
export const AUDIT_ACTIONS = [
  // 用户管理
  'change_role',
  'ban_user',
  'unban_user',
  'reset_password',
  'force_logout',
  'create_user',
  // 内容管理
  'delete_blog',
  'restore_blog',
  'delete_comment',
  'restore_comment',
  'delete_clip',
  'restore_clip',
  'delete_vote',
  'restore_vote',
  'restore_image',
  'delete_chat_message',
  // 系统运维
  'decide_appeal',
  'revoke_invite_code',
  'frame_grant',
  'frame_revoke',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 中文名。绝不要把机器码塞进界面 —— 用户看到的是这一列。 */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  change_role: '角色变更',
  ban_user: '禁言用户',
  unban_user: '解除禁言',
  reset_password: '重置密码',
  force_logout: '强制下线',
  create_user: '创建用户',
  delete_blog: '删除文章',
  restore_blog: '恢复文章',
  delete_comment: '删除评论',
  restore_comment: '恢复评论',
  delete_clip: '删除剪贴板',
  restore_clip: '恢复剪贴板',
  delete_vote: '删除投票',
  restore_vote: '恢复投票',
  restore_image: '恢复图片',
  delete_chat_message: '删除讨论消息',
  decide_appeal: '处理申诉',
  revoke_invite_code: '撤销邀请码',
  frame_grant: '发放头像框',
  frame_revoke: '收回头像框',
};

/** 筛选下拉里的分块。 */
export type AuditActionGroup = 'user' | 'content' | 'system';
export const AUDIT_GROUP_LABEL: Record<AuditActionGroup, string> = {
  user: '用户管理',
  content: '内容管理',
  system: '系统运维',
};
export const AUDIT_ACTION_GROUP: Record<AuditAction, AuditActionGroup> = {
  change_role: 'user',
  ban_user: 'user',
  unban_user: 'user',
  reset_password: 'user',
  force_logout: 'user',
  create_user: 'user',
  delete_blog: 'content',
  restore_blog: 'content',
  delete_comment: 'content',
  restore_comment: 'content',
  delete_clip: 'content',
  restore_clip: 'content',
  delete_vote: 'content',
  restore_vote: 'content',
  restore_image: 'content',
  delete_chat_message: 'content',
  decide_appeal: 'system',
  revoke_invite_code: 'system',
  frame_grant: 'system',
  frame_revoke: 'system',
};

/**
 * chip 的**配色档**（与权限无关，只用来一眼扫出「这条是删、是恢复、还是动了账号」）：
 * 惩罚=红 / 恢复=绿 / 账号=品牌蓝 / 系统=中性灰。落点是 `.audit-chip--<kind>`。
 */
export type AuditActionKind = 'punish' | 'restore' | 'account' | 'system';
export const AUDIT_ACTION_KIND: Record<AuditAction, AuditActionKind> = {
  ban_user: 'punish',
  delete_blog: 'punish',
  delete_comment: 'punish',
  delete_clip: 'punish',
  delete_vote: 'punish',
  delete_chat_message: 'punish',
  unban_user: 'restore',
  restore_blog: 'restore',
  restore_comment: 'restore',
  restore_clip: 'restore',
  restore_vote: 'restore',
  restore_image: 'restore',
  change_role: 'account',
  reset_password: 'account',
  create_user: 'account',
  force_logout: 'system',
  decide_appeal: 'system',
  revoke_invite_code: 'system',
  frame_grant: 'system',
  frame_revoke: 'system',
};

/**
 * 动作对象（`AdminActionLog.objectType`）的白名单与中文名。
 * 顺序 = 筛选下拉里的顺序。
 */
export const AUDIT_OBJECT_TYPES = [
  'blog',
  'comment',
  'user',
  'vote',
  'clipboard',
  'image',
  'chat_message',
  'invite_code',
  'user_frame',
  'admin_action_appeal',
] as const;
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];
export const AUDIT_OBJECT_TYPE_LABEL: Record<AuditObjectType, string> = {
  blog: '文章',
  comment: '评论',
  user: '用户',
  vote: '投票',
  clipboard: '剪贴板',
  image: '图片',
  chat_message: '讨论消息',
  invite_code: '邀请码',
  user_frame: '头像框',
  admin_action_appeal: '申诉',
};

/**
 * **只有 CLI 会写**的两个码（`scripts/cli/commands/frames.ts`）。
 * 走 `runAsBackendOps()` 写下的日志缺省 `visibility='internal'`（见 `audit-context.ts`），
 * 因此它们**永远不会出现在对外公示的 `/audit` 页**上。
 * 公开页的筛选下拉据此把它们滤掉 —— 留着的话，选中永远得到空结果、看着像页面坏了。
 */
export const CLI_ONLY_ACTIONS = ['frame_grant', 'frame_revoke'] as const;

/** `/audit` 公示页可选的动作（= 全部 − CLI-only）。 */
export const PUBLIC_AUDIT_ACTIONS: AuditAction[] = AUDIT_ACTIONS.filter(
  (a) => !(CLI_ONLY_ACTIONS as readonly string[]).includes(a)
);
/** `/audit` 公示页可选的对象类型（`user_frame` 同上，只由 CLI 写）。 */
export const PUBLIC_AUDIT_OBJECT_TYPES: AuditObjectType[] = AUDIT_OBJECT_TYPES.filter(
  (t) => t !== 'user_frame'
);

/**
 * 白名单解析：非白名单 / 空 / undefined → **null**（不静默给默认档）。
 * 调用方（读口筛选）拿到 null 就当作「没传这个筛选」，而不是 400 —— 筛选值非法退回
 * 「不筛」比报错好；真正要 fail-closed 的是写路径，那里不走这个函数。
 */
export function parseAction(raw: unknown): AuditAction | null {
  return typeof raw === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(raw)
    ? (raw as AuditAction)
    : null;
}

/** 宽松展示查找：已知码返回中文，未知码返回 null（调用方 `?? code` 回退原始码）。 */
export function actionLabel(code: string): string | null {
  return (AUDIT_ACTION_LABEL as Record<string, string | undefined>)[code] ?? null;
}

/** 未知码归到中性档 —— chip 宁可没颜色，也不能因为查不到就抛。 */
export function actionKind(code: string): AuditActionKind {
  return (AUDIT_ACTION_KIND as Record<string, AuditActionKind | undefined>)[code] ?? 'system';
}

export function actionGroup(code: string): AuditActionGroup {
  return (AUDIT_ACTION_GROUP as Record<string, AuditActionGroup | undefined>)[code] ?? 'system';
}

/** 宽松展示查找：未知对象类型返回 null（调用方 `?? type` 回退原始值）。 */
export function objectTypeLabel(type: string): string | null {
  return (AUDIT_OBJECT_TYPE_LABEL as Record<string, string | undefined>)[type] ?? null;
}

/** 取 UUID 前 8 位。够在同一屏里区分，又不至于把列撑爆。 */
function brief(v: string): string {
  return v.length > 12 ? `${v.slice(0, 8)}…` : v;
}

/**
 * 把一条日志的 `extra`（metadata）变成次行的一小句中文；拿不出可说的就返回 null。
 *
 * ⚠️ **这是白名单 switch，不是通用渲染器**：只认下面列出的 key。将来某个写入方往
 * `metadata` 里塞了敏感串（密码、邮箱、token），它会**照旧不显示** —— 别把它改成
 * 「把所有 value 拼起来」，那等于给未来的每一个 bug 开一条泄露出路。
 *
 * `new Date(iso)` 在这里是合法的：`db-time-guard` 只禁**无参** `new Date()`（那是拿
 * 真实时钟）与 `Date.now()` 相减；解析一个已知的 ISO 字符串不碰时钟。
 */
export function formatActionDetail(
  code: string,
  extra: Record<string, unknown> | null | undefined
): string | null {
  const e = extra ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const when = (v: unknown): string | null => {
    const s = str(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : ymdhms(d);
  };

  switch (parseAction(code)) {
    case 'change_role': {
      const from = str(e.from);
      const to = str(e.to);
      return from && to ? `${from} → ${to}` : null;
    }
    case 'ban_user': {
      const hours = num(e.hours);
      if (hours != null) return `禁言 ${hours} 小时`;
      const until = when(e.ban_until);
      return until ? `禁言至 ${until}` : null;
    }
    case 'reset_password':
      return e.generated === true ? '已生成随机密码' : '已重置密码';
    case 'create_user': {
      const role = str(e.role);
      if (!role) return null;
      return e.email_synthesized === true ? `创建为 ${role}（合成邮箱）` : `创建为 ${role}`;
    }
    case 'decide_appeal': {
      const id = num(e.appeal_id);
      if (id == null) return null;
      const result = str(e.result);
      const word = result === 'accepted' ? '已通过' : result === 'rejected' ? '已驳回' : result;
      return `申诉 #${id}${word ? ` · ${word}` : ''}`;
    }
    case 'delete_blog':
    case 'restore_blog': {
      // 现行写入方**不写** blog_title（admin-blog-service 只写 reason）—— 这里留着
      // 是照看迁移前的历史行，那些行的 extra 里可能还带着标题。
      const title = str(e.blog_title);
      return title ? `《${title}》` : null;
    }
    case 'delete_comment':
    case 'restore_comment': {
      const blogId = str(e.blog_id);
      return blogId ? `文章 ${brief(blogId)}` : null;
    }
    case 'delete_chat_message': {
      const channelId = str(e.channel_id);
      return channelId ? `频道 ${brief(channelId)}` : null;
    }
    case 'frame_grant': {
      const until = when(e.expires_at);
      return until ? `到期 ${until}` : '永久持有';
    }
    case 'frame_revoke':
      if (e.revoked === false) return '空操作（本来就没持有）';
      return e.unequipped === true ? '已收回并摘下' : '已收回';
    default:
      return null;
  }
}
