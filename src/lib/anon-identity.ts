// ─────────────────────────────────────────────────────────────────────────────
// anon-identity.ts — 匿名评论的**化名**：名字表、发号、按名生成头像。
//
// 【与另外两个「匿名」区分开】本仓已经有两条别的「匿名」，别混：
//   · 「匿名读」= 无需登录的公开读口（见 tests/unit/anonymous-read-guard.test.ts）；
//   · 「匿名用户」= 评论作者已注销、DTO 里 author 为 null 时的兜底显示名
//     （comment-service 的 DELETED_PLACEHOLDER 一带）。
//   本文件说的是第三件事：**发评论的人主动勾选「匿名」**，于是站内给他一枚化名。
//   所以正文里一律叫「化名」，不叫「匿名用户名」。
//
// ── 名字是怎么排的 ───────────────────────────────────────────────────────────
// 序号是 1-based（第 1 个匿名评论的人是 1 号），化名由序号**纯函数**推出：
//
//   seq 1..26      →  Alice, Bob, Carol, … Zach            （26 个名字，A→Z 打头）
//   seq 27..52     →  Angry Alice, Angry Bob, …            （前缀 1：「Angry」，A 打头）
//   …
//   seq 651..676   →  Yawning Alice … Yawning Zach         （前缀 25：「Yawning」，Y 打头）
//   seq 677 起      →  You Win #677, You Win #678, …        （游戏通关那种彩蛋）
//
// 26 个前缀 × 26 个名字 = 676 —— 于是第 677 个正好是 `You Win #677`。这不是巧合：
// 站长给的边界就是这个数，而 676 = 26×26 是**唯一**能同时满足
// 「首轮 26 个裸名」「次轮起加前缀」「到 677 换彩蛋」的排法。
//
// ⚠️ 所以前缀表里有且只有 25 个词（A–Y），第 0 个是**空串**（首轮裸名用它）。
//   「到 ZZ」在上面的排法里对应的是 `Yawning Zach`（最后一个常规化名）—— 站长那句
//   「ZZ」是「排到最后一格」的通俗说法，不是字面两个 Z。**别为了凑字面的 ZZ 去加第 26 个
//   前缀词**：那会把总数顶到 702，`You Win #677` 的边界随之失效（而它是对外承诺过的）。
//
// 名字取经典的「密码学协议人物」表（Alice/Bob/Carol/Mallory…），前缀尽量带站内元素
// （F = Fish 鱼干、H = Hungry 投喂、T = Turbo 练手盘、P = Pixel 头像框、L = Lucky 彩票档…）。
//
// ── 为什么序号要冻在评论文里 ─────────────────────────────────────────────────
// 「第几个」是**文章的历史事实**。判据一旦改成读时现算（按评论时间取第 k 个），
// 删掉一条评论或作者注销都会让同一个人的化名**无声改名** —— 那是匿名承诺的直接违约。
// 所以：权威是 blog_anon_identities 那一行，判据副本是 blog_comments.anon_seq，
// 化名表将来怎么改都不会让历史评论改名（改了只会让**新**号换名字）。
//
// ── 头像 ─────────────────────────────────────────────────────────────────────
// 「按用户名哈希生成」：种子是**化名**，不是真实用户 id。
//   · 用真实 id 做种子 = 同一个人在不同文章下的头像一模一样 = 跨文章的关联指纹，
//     等于把「这两条匿名评论是同一个人」白送给读者；
//   · 用化名做种子 = 同一篇文章内稳定、跨文章不可关联。
// 种子带一个 `~`（RFC 3986 的 unreserved 字符，永不被百分号编码），它落在
// resolveAvatar 的 `[a-zA-Z0-9_-]` 之外 —— 于是那张图**必然**是现算的 identicon，
// 绝不会去读 instance/avatars/<种子>.png（否则站长恰好放了一个同名文件就能盖掉它）。
//
// 本模块**只给服务端用**（node:crypto）。客户端拿的是 DTO 里算好的
// author.username 与 author.avatar_url，一个字都不用自己算。
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
 * 26 个前缀，与名字**同长**（两者相乘 = 676，见文件头那段算术）。
 * 第 0 项是空串 —— 首轮就是裸名字（「第一个是 Alice」）。
 * 其余 25 个依次以 A–Y 打头；站内元素尽量塞在这里。
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
] as const;

/**
 * 常规化名的总数 = 26 × 26 = 676。
 * 超过它就走 `You Win #<序号>`（序号即 1-based 的 seq，所以第一个彩蛋正好是 #677）。
 */
export const PSEUDONYM_VARIANTS = PSEUDONYM_NAMES.length * PSEUDONYM_PREFIXES.length;

// 上面两张表必须**同长**：不同长的话 floor(i/26) 会翻出 undefined，拼出
// 「undefined Alice」这种化名 —— 不报错、只是名字难看，最难发现。启动即断言。
if (PSEUDONYM_PREFIXES.length !== PSEUDONYM_NAMES.length) {
  throw new Error('PSEUDONYM_PREFIXES 与 PSEUDONYM_NAMES 必须同长（见 anon-identity.ts 头部）');
}

/**
 * 序号（1-based）→ 化名。纯函数，无 IO。
 *
 * 越界不抛：化名是渲染层的东西，为一条脏数据把整棵评论树炸掉不划算。
 * seq < 1 折到第 1 号，seq > 676 就是彩蛋档（那个分支天然容得下任意大的序号）。
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
