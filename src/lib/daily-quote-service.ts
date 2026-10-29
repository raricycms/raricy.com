// ─────────────────────────────────────────────────────────────────────────────
// 每日一言：全站 UTC+8 每日固定一句，社区优先，90 天内不重新选用同一内容。
// 签到到账与一言读取独立：展示失败不能回滚签到，也不能改变当天已选定的一句。
//
// 【共鸣资格 = 每人每句一生一次，不按日】2026-10 起资格由
// `daily_quote_resonance_once` 的联合主键 (quote_id, user_id) 决定：换日、取消再收藏、
// 90 天后再次入选都不会重置。`daily_quote_resonances` 退化成**明细 / 审计**（哪天共鸣
// 的、付了多少），它的行数**不再**决定按钮状态或显示人数 —— 存量里跨日重复的行原样
// 保留，所以「你去重一次」不能靠它，否则同一人会被重复计数。
//
// 【两层数据各自只读一处】
//   · 资格、人数、本人状态  → 只查 `daily_quote_resonance_once`
//   · 「那天有没有一言」    → 只查 `daily_quote_editions`（某天没被选中就没有那一期）
//   · 正文与审核状态        → 只查 `daily_quotes`（approved + 投稿人未归档）
//
// 【读口一律走同一个批量组装器】今日弹窗、往期列表、一言集三条入口必须对「匿名 / 下架
// / 已共鸣 / 收藏」给出完全一致的答案，所以状态组装只有 buildQuoteViews 一处。逐个
// 调 quoteView 的历史列表会 N+1（每期 4 次查询），也更容易漏掉某个状态。
//
// 【往期列表是纯读】它不调用 selectEdition / getTodayQuote：惰性选句只在「首次读取今日
// 一言」发生，历史查询不能替今天或过去补抽，否则会凭空造出「那天选中过」的记录。
//
// 【钱的边界】社区稿共鸣由付款者出 1 条鱼干、全额交给投稿人，经典免费；两侧记账与
// 资格行、明细行在**同一个事务**里提交，余额不足全部回滚。匿名稿件的读口不返回投稿人
// 账号 ID / 昵称，付款流水的关联收款人置空。
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { DailyQuote, Prisma } from '@prisma/client';
import { prisma } from './db';
import { dayStart, nowForDb, todayStr } from './db-time';
import { hasAdminRights, isCoreUser, isCurrentlyBanned } from './auth';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { rateLimit, RULES } from './rate-limit';
import {
  QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, QUOTE_HISTORY_PAGE_SIZE, QUOTE_NO_REPEAT_DAYS,
  QUOTE_RESONANCE_FISH, QUOTE_SAVED_PAGE_SIZE, QUOTE_STATUSES, normalizeQuotePage, quoteLength,
  type DailyQuoteHistoryEntry, type DailyQuoteResonanceResult, type DailyQuoteView,
  type SavedQuoteEntry,
} from './daily-quote';

export class QuoteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function quoteContentKey(content: string): string {
  return createHash('sha256').update(content.normalize('NFKC').replace(/[\p{P}\p{Z}\p{C}]/gu, '')).digest('hex');
}

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}

const activeSubmitter = {
  OR: [{ kind: 'builtin' }, { submitter: { archivedAt: null } }],
} satisfies Prisma.DailyQuoteWhereInput;

// 模块可能在热更新或不同 Next 编译图里实例化，合并在途选取要放到 globalThis。
const state = globalThis as unknown as { __dailyQuotePending: Map<string, Promise<string>> };
state.__dailyQuotePending ??= new Map();

async function selectEdition(day: string): Promise<string> {
  const existing = await prisma.dailyQuoteEdition.findUnique({ where: { day } });
  if (existing) return existing.quoteId;
  try {
    return await prisma.$transaction(async (tx) => {
      const previous = new Date(dayStart(day).getTime() - QUOTE_NO_REPEAT_DAYS * 86400000).toISOString().slice(0, 10);
      const recent = await tx.dailyQuoteEdition.findMany({
        where: { day: { gte: previous, lt: day } }, select: { quoteId: true },
      });
      const eligible = {
        status: 'approved', id: { notIn: recent.map((item) => item.quoteId) },
        ...activeSubmitter,
      } satisfies Prisma.DailyQuoteWhereInput;
      let candidates = await tx.dailyQuote.findMany({
        where: { ...eligible, kind: 'community', submitter: { archivedAt: null, role: { in: ['core', 'admin', 'owner'] } } },
        select: { id: true },
      });
      if (!candidates.length) candidates = await tx.dailyQuote.findMany({
        where: { ...eligible, kind: 'builtin' }, select: { id: true },
      });
      if (!candidates.length) throw new QuoteError(503, '今日暂无可用的一言，请稍后再试');
      const quoteId = candidates[randomInt(candidates.length)].id;
      await tx.dailyQuoteEdition.create({ data: { day, quoteId, createdAt: nowForDb() } });
      return quoteId;
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      const winner = await prisma.dailyQuoteEdition.findUnique({ where: { day } });
      if (winner) return winner.quoteId;
    }
    throw error;
  }
}

async function editionQuoteId(day: string): Promise<string> {
  const pending = state.__dailyQuotePending.get(day);
  if (pending) return pending;
  const operation = selectEdition(day);
  state.__dailyQuotePending.set(day, operation);
  try { return await operation; }
  finally { state.__dailyQuotePending.delete(day); }
}

async function checkedIn(userId: string, day: string) {
  return Boolean(await prisma.dailyCheckIn.findUnique({
    where: { uq_user_checkin_date: { userId, checkinDate: dayStart(day) } }, select: { id: true },
  }));
}

/** 组装展示状态时要读的投稿人列（角色、归档、禁言决定「能不能收投喂」）。 */
const submitterSelect = {
  id: true, username: true, role: true, archivedAt: true, isBanned: true, banUntil: true,
} satisfies Prisma.UserSelect;

/**
 * 批量组装展示状态：一次调用产出整页（或单条）的所有 `DailyQuoteView`。
 *
 * 【为什么只有一个组装器】今日 / 往期 / 一言集三条读口共用它，才能保证同一句在三个
 * 入口的 `resonated` / `favorited` / `resonance_count` 完全一致。逐条 `quoteView` 会让
 * 一页 20 期发出 80+ 次查询，而历史列表正是第一个撞上这个量的入口。
 *
 * 【查询数是常数】投稿人 / 本人资格 / 本人收藏 / 人数各一次，与条数无关。
 * 人数**沿用账号归档边界**：归档账号的历史共鸣不计入显示人数（与改版前一致），
 * 但他们的资格行仍保留 —— 账号恢复后不会重新获得共鸣资格。
 */
async function buildQuoteViews(quotes: DailyQuote[], userId: string): Promise<Map<string, DailyQuoteView>> {
  const views = new Map<string, DailyQuoteView>();
  if (quotes.length === 0) return views;

  const quoteIds = [...new Set(quotes.map((quote) => quote.id))];
  const submitterIds = [...new Set(quotes.map((quote) => quote.submitterId).filter((id): id is string => Boolean(id)))];
  const [submitters, resonatedRows, favoriteRows, countRows] = await Promise.all([
    // `id: { in: [] }` 合法且返回空集，不必为「本页全是经典」分叉一条查询。
    prisma.user.findMany({ where: { id: { in: submitterIds } }, select: submitterSelect }),
    prisma.dailyQuoteResonanceOnce.findMany({ where: { userId, quoteId: { in: quoteIds } }, select: { quoteId: true } }),
    prisma.dailyQuoteFavorite.findMany({
      where: { userId, quoteId: { in: quoteIds }, deleted: false }, select: { quoteId: true },
    }),
    prisma.dailyQuoteResonanceOnce.groupBy({
      by: ['quoteId'],
      where: { quoteId: { in: quoteIds }, user: { archivedAt: null } },
      _count: { _all: true },
    }),
  ]);
  const submitterById = new Map(submitters.map((user) => [user.id, user]));
  const resonated = new Set(resonatedRows.map((row) => row.quoteId));
  const favorited = new Set(favoriteRows.map((row) => row.quoteId));
  const resonanceCounts = new Map(countRows.map((row) => [row.quoteId, row._count._all]));

  for (const quote of quotes) {
    const submitter = quote.submitterId ? submitterById.get(quote.submitterId) ?? null : null;
    // 归属判断留在服务端：只下发 can_resonate 与原因，匿名时不带任何投稿人标识。
    let unavailable: string | null = null;
    if (quote.submitterId === userId) unavailable = '不能给自己的投稿共鸣';
    else if (quote.kind === 'community' && (!submitter || !isCoreUser(submitter) || isCurrentlyBanned(submitter))) {
      unavailable = '投稿人当前无法接收投喂';
    }
    const resonatedOnce = resonated.has(quote.id);
    const name = quote.kind === 'builtin' ? quote.authorName ?? '佚名'
      : quote.signature === 'anonymous' ? '匿名' : submitter?.username ?? '已注销用户';
    views.set(quote.id, {
      id: quote.id, content: quote.content, category: quote.category, kind: quote.kind,
      author: name, source_type: quote.sourceType, source_name: quote.sourceName, source_url: quote.sourceUrl,
      submitter_name: quote.kind === 'community' ? name : null,
      resonance_count: resonanceCounts.get(quote.id) ?? 0,
      resonated: resonatedOnce,
      favorited: favorited.has(quote.id),
      resonance_fish: quote.kind === 'community' ? QUOTE_RESONANCE_FISH : 0,
      // 终身资格：已共鸣之后按钮永远不可再点（不提供取消，也没有「明天再来」）。
      can_resonate: !unavailable && !resonatedOnce,
      resonance_unavailable: unavailable,
    });
  }
  return views;
}

/**
 * 单条展示状态（保持「一条也能取」的旧语义，内部走同一个批量组装器）。
 * 只给确实只需要一条的调用方用；列表一律走 `buildQuoteViews`，别在循环里调它。
 */
export async function quoteView(quote: DailyQuote, userId: string): Promise<DailyQuoteView> {
  const view = (await buildQuoteViews([quote], userId)).get(quote.id);
  if (!view) throw new Error(`每日一言展示状态组装失败：${quote.id}`);
  return view;
}

export async function getTodayQuote(userId: string): Promise<{ day: string; quote: DailyQuoteView | null }> {
  const day = todayStr();
  if (!(await checkedIn(userId, day))) throw new QuoteError(403, '完成今日签到后可查看每日一言');
  const id = await editionQuoteId(day);
  const quote = await prisma.dailyQuote.findFirst({ where: { id, status: 'approved', ...activeSubmitter } });
  // 下架不重新抽取，避免同一天不同人看到两句；保留当天占位及历史选择记录。
  return { day, quote: quote ? await quoteView(quote, userId) : null };
}

async function publishedQuote(quoteId: string, tx: Prisma.TransactionClient = prisma) {
  const quote = await tx.dailyQuote.findFirst({
    where: { id: quoteId, status: 'approved', editions: { some: {} }, ...activeSubmitter },
  });
  if (!quote) throw new QuoteError(404, '一言不存在或已下架');
  return quote;
}

async function requireActor(userId: string, tx: Prisma.TransactionClient = prisma) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: {
    id: true, role: true, archivedAt: true, isBanned: true, banUntil: true, driedFish: true,
  } });
  if (!user || !isCoreUser(user)) throw new QuoteError(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) throw new QuoteError(403, '禁言期间暂时无法操作');
  return user;
}

/** 权威人数：只数累计资格表，并沿用账号归档边界（归档账号不计入显示人数）。 */
async function resonanceCountOf(quoteId: string, client: Prisma.TransactionClient = prisma): Promise<number> {
  return client.dailyQuoteResonanceOnce.count({ where: { quoteId, user: { archivedAt: null } } });
}

/**
 * 共鸣接口的返回：资格一经写下就是终态，因此 `resonated` 恒为 true、
 * `can_resonate` 恒为 false（既没有取消，也没有「明天再来」）。
 * `resonance_unavailable` 也恒定 null —— 已共鸣的说明优先于「作者当前不能收款」。
 */
function resonanceResult(already: boolean, resonanceCount: number, balance: number): DailyQuoteResonanceResult {
  return {
    already_resonated: already,
    resonated: true,
    can_resonate: false,
    resonance_count: resonanceCount,
    resonance_unavailable: null,
    balance,
  };
}

/**
 * 共鸣：**同一用户对同一句一言一生一次**。
 *
 * 事务内顺序：资格复核 → 自共鸣 / 收款人资格 → 写累计资格行 → 写明细行 → 付费两侧记账。
 * 累计资格行的联合主键是并发防线：两个请求同时通过复核时，后写的那个撞 P2002，整笔
 * 回滚（不扣钱、不写明细），由外层按「已共鸣」幂等返回。
 *
 * ⚠️ 外层只把「累计资格行确实存在」的 P2002 转成幂等成功；其它约束冲突（例如明细行的
 * (quote, user, day) 三元主键）原样抛出 —— 把真正的数据异常说成「你早就共鸣过了」，
 * 会让重复扣款或数据错位永远查不出来。
 *
 * 重复请求（含跨日、跨标签页）不增加人数、不产生鱼干流水，返回权威的
 * `resonance_count` 与当前余额，客户端据此回填而不许自己 +1。
 */
export async function resonateQuote(quoteId: string, userId: string): Promise<DailyQuoteResonanceResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const actor = await requireActor(userId, tx);
      const quote = await publishedQuote(quoteId, tx);
      const prior = await tx.dailyQuoteResonanceOnce.findUnique({
        where: { uq_daily_quote_resonance_once: { quoteId, userId } }, select: { quoteId: true },
      });
      if (prior) return resonanceResult(true, await resonanceCountOf(quoteId, tx), unitsToFish(actor.driedFish));
      if (quote.submitterId === userId) throw new QuoteError(400, '不能给自己的投稿共鸣');

      const paidUnits = quote.kind === 'community' ? fishToUnits(QUOTE_RESONANCE_FISH) : 0;
      if (paidUnits) {
        if (!quote.submitterId) throw new QuoteError(400, '投稿人当前无法接收投喂');
        await requireActor(quote.submitterId, tx);
      }

      // 资格行先写：并发重复在这里撞主键，唯一约束是最终防线。
      await tx.dailyQuoteResonanceOnce.create({ data: { quoteId, userId, firstResonatedAt: nowForDb() } });
      // 明细行只服务历史审计：记录这次实际发生的日期与当次付款额，不参与任何判据。
      await tx.dailyQuoteResonance.create({ data: { quoteId, userId, day: todayStr(), paidUnits, createdAt: nowForDb() } });
      if (paidUnits) {
        if (!quote.submitterId) throw new QuoteError(400, '投稿人当前无法接收投喂');
        await postEntry(tx, {
          userId, units: -paidUnits, type: 'quote_resonance', description: '每日一言共鸣投喂',
          referenceType: 'daily_quote', referenceId: quoteId,
          relatedUserId: quote.signature === 'anonymous' ? null : quote.submitterId,
        });
        await postEntry(tx, {
          userId: quote.submitterId, units: paidUnits, type: 'quote_resonance_receive',
          description: '每日一言收到共鸣投喂', referenceType: 'daily_quote', referenceId: quoteId, relatedUserId: userId,
        });
      }
      return resonanceResult(false, await resonanceCountOf(quoteId, tx), unitsToFish(actor.driedFish - paidUnits));
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      const prior = await prisma.dailyQuoteResonanceOnce.findUnique({
        where: { uq_daily_quote_resonance_once: { quoteId, userId } }, select: { quoteId: true },
      });
      if (prior) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
        return resonanceResult(true, await resonanceCountOf(quoteId), unitsToFish(user?.driedFish ?? 0));
      }
    }
    if (error instanceof InsufficientFishError) throw new QuoteError(400, '小鱼干不足，共鸣需要1条鱼干');
    throw error;
  }
}

export async function saveQuote(quoteId: string, userId: string, saved: boolean) {
  await requireActor(userId);
  if (saved) await publishedQuote(quoteId);
  // 移出收藏也允许作用于下架内容，以免私密分类里留下无法清理的条目。
  if (saved) await prisma.dailyQuoteFavorite.upsert({
    where: { uq_daily_quote_favorite: { userId, quoteId } },
    create: { userId, quoteId, createdAt: nowForDb() },
    update: { deleted: false, deletedAt: null, createdAt: nowForDb() },
  });
  else await prisma.dailyQuoteFavorite.updateMany({
    where: { userId, quoteId, deleted: false }, data: { deleted: true, deletedAt: nowForDb() },
  });
}

/**
 * 往期一言：**系统实际选用过**的过去日期，按日期倒序分页。
 *
 * 【只读，绝不惰性选句】这里不调用 `selectEdition` / `getTodayQuote`：某天没有选用记录
 * 就是没有那一期（缺日不补抽），查询也**不会**为今天或过去创建 edition 行。列表只取
 * `day < todayStr()`，把今天排除在外 —— 否则往期就成了绕过签到看今日内容的入口。
 *
 * 【内容不可展示时保留日期】下架 / 投稿人归档 / 审核状态变化都会让 `quote` 变成 null，
 * 但日期必须留着：「那天有过一言」是这一期唯一的痕迹，抹掉整条会让历史凭空缺一天。
 *
 * 状态组装走 buildQuoteViews（一次批量查询），不逐条读。
 */
export async function listQuoteHistory(
  userId: string,
  page = 1,
): Promise<{ page: number; pages: number; total: number; editions: DailyQuoteHistoryEntry[] }> {
  const where: Prisma.DailyQuoteEditionWhereInput = { day: { lt: todayStr() } };
  const total = await prisma.dailyQuoteEdition.count({ where });
  const { page: currentPage, pages } = normalizeQuotePage(page, total, QUOTE_HISTORY_PAGE_SIZE);
  if (total === 0) return { page: currentPage, pages, total, editions: [] };

  const rows = await prisma.dailyQuoteEdition.findMany({
    where,
    orderBy: { day: 'desc' },
    skip: (currentPage - 1) * QUOTE_HISTORY_PAGE_SIZE,
    take: QUOTE_HISTORY_PAGE_SIZE,
    select: { day: true, quoteId: true },
  });
  const quotes = await prisma.dailyQuote.findMany({
    where: { id: { in: rows.map((row) => row.quoteId) }, status: 'approved', ...activeSubmitter },
  });
  const views = await buildQuoteViews(quotes, userId);
  const editions: DailyQuoteHistoryEntry[] = rows.map((row) => ({
    day: row.day,
    quote: views.get(row.quoteId) ?? null,
  }));
  return { page: currentPage, pages, total, editions };
}

/**
 * 私密一言集：本人未取消的收藏，按收藏时间倒序分页。
 *
 * `last_day` 是这条内容**最近一次入选**的日期（不是收藏时间），用一次 groupBy 取
 * _max(day)，不做逐条查询。下架内容保留占位（`quote: null`）与 `last_day`，仍可移出
 * —— 否则私密分类里会留下无法清理的条目。
 *
 * 页码按 `normalizeQuotePage` 收敛：取消末页最后一条后再刷新会回到有效末页。
 */
export async function listSavedQuotes(
  userId: string,
  page = 1,
): Promise<{ total: number; page: number; pages: number; quotes: SavedQuoteEntry[] }> {
  const where: Prisma.DailyQuoteFavoriteWhereInput = { userId, deleted: false };
  const total = await prisma.dailyQuoteFavorite.count({ where });
  const { page: currentPage, pages } = normalizeQuotePage(page, total, QUOTE_SAVED_PAGE_SIZE);
  if (total === 0) return { total, page: currentPage, pages, quotes: [] };

  const rows = await prisma.dailyQuoteFavorite.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (currentPage - 1) * QUOTE_SAVED_PAGE_SIZE,
    take: QUOTE_SAVED_PAGE_SIZE,
    select: { quoteId: true },
  });
  const quoteIds = rows.map((row) => row.quoteId);
  const [quotes, lastDays] = await Promise.all([
    prisma.dailyQuote.findMany({ where: { id: { in: quoteIds }, status: 'approved', ...activeSubmitter } }),
    prisma.dailyQuoteEdition.groupBy({ by: ['quoteId'], where: { quoteId: { in: quoteIds } }, _max: { day: true } }),
  ]);
  const views = await buildQuoteViews(quotes, userId);
  const lastDayByQuote = new Map(lastDays.map((row) => [row.quoteId, row._max.day ?? null]));
  const entries: SavedQuoteEntry[] = rows.map((row) => ({
    id: row.quoteId,
    last_day: lastDayByQuote.get(row.quoteId) ?? null,
    quote: views.get(row.quoteId) ?? null,
  }));
  return { total, page: currentPage, pages, quotes: entries };
}

export async function submitQuote(userId: string, input: Record<string, unknown>) {
  await requireActor(userId);
  const gate = rateLimit(`quote:submit:${userId}`, RULES.quoteSubmitDaily);
  if (!gate.allowed) throw new QuoteError(429, '今日投稿次数已用完，请明天再来');
  const { content, category, signature, source_type, source_name } = input;
  if (typeof content !== 'string' || /[\p{Cc}\p{Cf}]/u.test(content.replace(/[\r\n\t]/g, ''))) {
    throw new QuoteError(400, '请输入有效的一言内容');
  }
  const text = content.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!text || quoteLength(text) > QUOTE_CONTENT_MAX || !/[\p{L}\p{N}]/u.test(text)) {
    throw new QuoteError(400, `一言内容需为1至${QUOTE_CONTENT_MAX}字`);
  }
  if (!(QUOTE_CATEGORIES as readonly unknown[]).includes(category)) throw new QuoteError(400, '请选择一言类型');
  if (signature !== 'nickname' && signature !== 'anonymous') throw new QuoteError(400, '请选择署名方式');
  if (source_type !== 'original' && source_type !== 'quotation') throw new QuoteError(400, '请选择原创或引用');
  const source = typeof source_name === 'string' ? source_name.trim() : '';
  if (source_type === 'quotation' && (!source || quoteLength(source) > 100)) throw new QuoteError(400, '引用请填写100字以内的原作者或出处');
  try {
    return await prisma.dailyQuote.create({ data: {
      id: randomUUID(), kind: 'community', content: text, contentKey: quoteContentKey(text),
      category: category as string, signature, sourceType: source_type,
      sourceName: source_type === 'quotation' ? source : null, submitterId: userId,
      status: 'pending', createdAt: nowForDb(),
    }, select: { id: true, status: true } });
  } catch (error) {
    if (uniqueViolation(error)) throw new QuoteError(409, '这句内容已收录或已被拒绝，不能重复投稿');
    throw error;
  }
}

export async function listSubmissions(userId: string) {
  return prisma.dailyQuote.findMany({
    where: { submitterId: userId, kind: 'community' }, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, content: true, category: true, signature: true, sourceType: true, sourceName: true, status: true, reviewReason: true, createdAt: true },
  });
}

export async function listReviewQuotes(status: string, page: number) {
  const selected = (QUOTE_STATUSES as readonly string[]).includes(status) ? status : 'pending';
  const current = Number.isSafeInteger(page) ? Math.max(1, page) : 1;
  const where = { status: selected, ...activeSubmitter };
  const [total, quotes] = await Promise.all([
    prisma.dailyQuote.count({ where }),
    prisma.dailyQuote.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (current - 1) * 30, take: 30,
      include: { submitter: { select: { username: true } } },
    }),
  ]);
  return { total, page: current, pages: Math.ceil(total / 30), status: selected, quotes };
}

export async function reviewQuote(quoteId: string, adminId: string, action: unknown, reason: unknown) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!['approve', 'reject', 'retire'].includes(action as string)) throw new QuoteError(400, '审核操作无效');
  if (quoteLength(trimmed) > 200 || (action !== 'approve' && !trimmed)) throw new QuoteError(400, '请填写200字以内的原因');
  const expected = action === 'retire' ? 'approved' : 'pending';
  const next = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'retired';
  await prisma.$transaction(async (tx) => {
    const reviewer = await requireActor(adminId, tx);
    if (!hasAdminRights(reviewer)) throw new QuoteError(403, '需要管理员权限');
    const quote = await tx.dailyQuote.findFirst({ where: { id: quoteId, status: expected, ...activeSubmitter } });
    if (!quote) throw new QuoteError(409, '稿件状态已变化，已拒绝的稿件不能重新通过');
    const updated = await tx.dailyQuote.updateMany({
      where: { id: quoteId, status: expected }, data: { status: next, reviewReason: trimmed || null, reviewerId: adminId, reviewedAt: nowForDb() },
    });
    if (!updated.count) throw new QuoteError(409, '稿件状态已变化，请刷新');
    const auditAction = action === 'approve' ? { action: 'daily_quote_approve' }
      : action === 'reject' ? { action: 'daily_quote_reject' } : { action: 'daily_quote_retire' };
    // 待审稿件与拒绝原因属于作者隐私，只记内部日志，避免公示出尚未发布的内容。
    await tx.adminActionLog.create({ data: {
      ...auditAction, adminId, targetUserId: quote.submitterId,
      objectType: 'daily_quote', objectId: quoteId, reason: trimmed || null,
      visibility: 'internal', hideTarget: quote.signature === 'anonymous', createdAt: nowForDb(),
    }, select: { id: true } }); // 不回读 extra（JSON 列）
  });
}
