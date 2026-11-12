// ─────────────────────────────────────────────────────────────────────────────
// anon-identity.ts — 匿名评论的**化名**：名字表、发号、按名生成头像
// 【三个「匿名」别混】匿名读 = 免登录公开读口（anonymous-read-guard.test.ts）；匿名用户 = 作者
//   注销后 DTO author 为 null 的兜底显示名；本文件是第三件：发评论者主动勾选「匿名」得到的
//   **化名**（正文里叫「化名」，不叫「匿名用户名」）。
// 【发号】序号 1-based，化名由序号纯函数推出：seq 1..26 → Alice..Zach；27..52 → Angry Alice..；
//   …；677..702 → Zealous Alice..Zealous Zach；703 起 → You Win #703..。规则是「排到 ZZ」：
//   前缀表有且只有 27 个词（第 0 个空串 + A–Z 各一行），27 × 26 = 702。
// ⚠️ 别删 Z 那一项（或任何别的）：总数会掉到 676，末位变 Yawning Zach（YZ），「排到 ZZ」
//   不再字面成立、彩蛋边界提前 —— 该边界是对外承诺（docs/bot/comment-bot.md §10.4）。
// 【序号冻在评论文里】「第几个」是文章历史事实：改成读时现算会让删评论 / 作者注销使同一人
//   无声改名 = 匿名承诺违约。权威是 blog_anon_identities 行，判据副本是 blog_comments.anon_seq；
//   化名表怎么改都不让历史评论改名（只让新号换名）。
// 【头像】种子是化名、不是真实 id（真实 id = 跨文章关联指纹）。种子带 ~（RFC 3986 unreserved，
//   落在 resolveAvatar 的 [a-zA-Z0-9_-] 之外）→ 必然现算 identicon，绝不读 instance/avatars/<种子>.png。
// 只给服务端用（node:crypto）；客户端拿 DTO 里算好的 author.username / author.avatar_url。
// 设计背景与取舍：docs/source-design-notes.md §6
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { avatarUrl } from './avatar-refs';
import { nowForDb } from './db-time';

/** 26 个名字，A→Z 打头（经典「密码学协议人物」表：Alice / Bob / Carol / Mallory…）。 */
export const PSEUDONYM_NAMES = [
  'Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace',
  'Heidi', 'Ivan', 'Judy', 'Karl', 'Leo', 'Mallory',
  'Nina', 'Olivia', 'Peggy', 'Quentin', 'Rupert', 'Sybil',
  'Trent', 'Uma', 'Victor', 'Wendy', 'Xavier', 'Yvonne', 'Zach',
] as const;

/**
 * 27 个前缀 = 空串 + A–Z，比名字表**多一个**（见文件头那段算术）。
 * 第 0 项是空串 —— 首轮就是裸名字（「第一个是 Alice」）。
 * 其余 26 个依次以 A–Z 打头；站内元素尽量塞在这里。
 */
export const PSEUDONYM_PREFIXES = [
  '',
  'Angry',      // A（站长点名的例子）
  'Bashful',
  'Cheerful',
  'Drowsy',
  'Emoji',      // 表情包 / 黄脸
  'Fish',       // F（站长点名的例子）：鱼干
  'Grumpy',
  'Hungry',     // 投喂
  'Invisible',  // 匿名本身
  'Jolly',
  'Kooky',
  'Lucky',      // 彩票档
  'Merry',
  'Nimble',
  'Odd',
  'Pixel',      // 头像框 / 像素
  'Quiet',
  'Rowdy',
  'Sleepy',
  'Turbo',      // 练手盘的杠杆
  'Unlucky',    // 爆仓
  'Vivid',
  'Wobbly',
  'Xenial',     // 待客友善 —— 对匿名访客正合适
  'Yawning',
  'Zealous',    // Z 那一行 —— 它的存在让末位正好是 `Zealous Zach`（字面的 ZZ）
] as const;

/**
 * 常规化名的总数 = 27 × 26 = 702。
 * 超过它就走 `You Win #<序号>`（序号即 1-based 的 seq，所以第一个彩蛋正好是 #703）。
 */
export const PSEUDONYM_VARIANTS = PSEUDONYM_NAMES.length * PSEUDONYM_PREFIXES.length;

// 前缀表必须**正好比名字表多一个**（多出来的那个是首行的空串）。长度不对的话
// floor(i/26) 会翻出 undefined，拼出「undefined Alice」这种化名 ——
// 不报错、只是名字难看，最难发现。启动即断言。
if (PSEUDONYM_PREFIXES.length !== PSEUDONYM_NAMES.length + 1) {
  throw new Error('PSEUDONYM_PREFIXES 必须比 PSEUDONYM_NAMES 多一个（空串那一项，见 anon-identity.ts 头部）');
}

/**
 * 序号（1-based）→ 化名。纯函数，无 IO。
 *
 * 越界不抛：化名是渲染层的东西，为一条脏数据把整棵评论树炸掉不划算。
 * seq < 1 折到第 1 号，seq > 702 就是彩蛋档（那个分支天然容得下任意大的序号）。
 */
export function pseudonymForSeq(seq: number): string {
  if (seq > PSEUDONYM_VARIANTS) return `You Win #${seq}`;
  const index = Math.min(Math.max(Math.trunc(seq) - 1, 0), PSEUDONYM_VARIANTS - 1);
  const prefix = PSEUDONYM_PREFIXES[Math.floor(index / PSEUDONYM_NAMES.length)];
  const name = PSEUDONYM_NAMES[index % PSEUDONYM_NAMES.length];
  return prefix ? `${prefix} ${name}` : name;
}

/**
 * 化名 → 头像地址。确定性：同一个化名永远同一张 identicon。
 *
 * 走 `avatarUrl()`（全仓唯一允许拼 /api/avatar/ 的地方，见 avatar-refs.ts），
 * 种子加 `anon~` 命名空间并哈希 —— 于是 URL 不含空格/中文，且绝不可能撞上
 * 真实用户 id（UUID）或站长手工放的 instance/avatars/<种子>.png。
 */
export function pseudonymAvatarUrl(pseudonym: string): string {
  const hex = createHash('md5').update(`anon-comment:${pseudonym}`, 'utf8').digest('hex');
  return avatarUrl(`anon~${hex}`);
}

/**
 * 取（或分配）某人在某篇文章下的化名序号。**必须在评论写入的同一个事务里调**。
 *
 * 【为什么发号靠 Blog.anonIdentityCount 自增，而不是 COUNT/MAX】
 * 两个人同时首次匿名评论时，「先读后写」会各自读到同一个值、发出同一个号 ——
 * 两个人同名，违反「不同的人在同一篇文章下必然不同号」。自增是一句原子的
 * UPDATE，谁先谁后由 SQLite 的写锁定序。
 *
 * 【为什么先查后发号】同一个人第二次匿名评论必须复用第一行的号（这是承诺）。
 * 查不到才发新号，并且 (blog_id, user_id) 的唯一索引会在「同一瞬间同一人两次提交」
 * 时当场报错（P2002）—— 那是响亮的失败，不是两个人同名那种静默错账。
 *
 * @returns 1-based 序号（1 = 这篇文章里第一个匿名评论的人）
 */
export async function resolvePseudonymSeqTx(
  tx: Prisma.TransactionClient,
  blogId: string,
  userId: string
): Promise<number> {
  const existing = await tx.blogAnonIdentity.findUnique({
    where: { blogId_userId: { blogId, userId } },
    select: { seq: true },
  });
  if (existing) return existing.seq;

  // 自增在**同一个事务**里：下面的评论插入若失败，这个号跟着回滚，不留空洞。
  const blog = await tx.blog.update({
    where: { id: blogId },
    data: { anonIdentityCount: { increment: 1 } },
    select: { anonIdentityCount: true },
  });
  const seq = blog.anonIdentityCount;

  await tx.blogAnonIdentity.create({
    data: { blogId, userId, seq, createdAt: nowForDb() },
  });
  return seq;
}
