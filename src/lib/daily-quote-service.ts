// ─────────────────────────────────────────────────────────────────────────────
// 每日一言：全站 UTC+8 每日固定一句。社区只选登一次，经典在社区候选耗尽后循环。
// 签到到账与一言读取独立：展示失败不能回滚签到，也不能改变当天已选定的一句。
//
// 【发行与阅读分离（2026-11 P03）】每日一期的选取是**后台发行**，不是读者触发的：
//   · `ensureEditionForDay(day)` 幂等发行当天一期（已有记录直接用；选句认领与落库
//     在同一个事务里，靠 `DailyQuoteEdition.day` 主键与条件 UPDATE 防并发重复）；
//   · `startDailyQuotePublisher()` 由 `src/instrumentation.ts` 在服务启动后调用：
//     启动时确保**当天**有发行，之后每分钟检查一次北京日期，跨日即发行新一天；
//   · `getTodayQuote()` **只读**发行记录，绝不选句 —— 读者访问不能凭空造出「那天
//     选中过」的记录（停机漏掉的旧期因此保持缺期，只补当天）。
//
// 【状态区分】读口返回 `state`：`published`（有正文）/ `pending`（当天尚未发行）/
// `failed`（当天发行失败，进程内记录，重启会重试）/ `unavailable`（有发行记录但
// 内容已下架或投稿人归档）。失败不写库也不阻塞签到，只影响今日入口的显示。
//
// 【共鸣资格 = 每人每句一生一次，不按日】2026-10 起资格由
// `daily_quote_resonance_once` 的联合主键 (quote_id, user_id) 决定：换日、取消再收藏、
// 经典再次入选都不会重置。`daily_quote_resonances` 退化成**明细 / 审计**（哪天共鸣
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
// 【钱的边界】可收款社区稿共鸣由付款者出 1 条鱼干、全额交给投稿人；失格与经典免费。两侧记账与
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
  QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, QUOTE_HISTORY_PAGE_SIZE,
  QUOTE_RESONANCE_FISH, QUOTE_SAVED_PAGE_SIZE, QUOTE_STATUSES, canEditQuoteSubmission, normalizeQuotePage, quoteLength,
  type DailyQuoteHistoryEntry, type DailyQuoteResonanceResult, type DailyQuoteView, type TodayQuoteState,
  quoteDisplayStatus, type SavedQuoteEntry,
} from './daily-quote';

export class QuoteError extends Error {
  constructor(public status: number, message: string, public reason?: string, public extra: object = {}) { super(message); }
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
const state = globalThis as unknown as {
  __dailyQuotePending: Map<string, Promise<string>>;
  __dailyQuoteIssuance?: {
    /** 当天发行失败（进程内；重启后由启动钩子重试）。 */
    failures: Map<string, { at: number; error: string }>;
    /** 定时器最近一次确认已发行的日期 —— 同一天内不重复扫。 */
    lastDay: string | null;
    timer: NodeJS.Timeout | null;
    started: boolean;
  };
};
state.__dailyQuotePending ??= new Map();
state.__dailyQuoteIssuance ??= { failures: new Map(), lastDay: null, timer: null, started: false };

async function selectEdition(day: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.dailyQuoteEdition.findUnique({ where: { day } });
    if (existing) return existing.quoteId;
    try {
      return await prisma.$transaction(async (tx) => {
        const rows = await tx.dailyQuote.findMany({
          // P03：不再要求「投稿人名下有未删除的博客」—— 资格只看账号角色 / 归档 /
          // 禁言（见下一行 where 与 rows.filter）。博客要求只留在参与门槛
          // （requireQuoteParticipant），不参与「这一句能不能被选登」。
          where: { status: 'approved', kind: 'community', firstSelectedDay: null, editions: { none: {} },
            submitter: { archivedAt: null, role: { in: ['core', 'admin', 'owner'] } } },
          select: { id: true, submitterId: true, submitter: { select: { isBanned: true, banUntil: true } } },
          orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
        });
        const candidates = rows.filter((row) => !isCurrentlyBanned(row.submitter));
        const yesterday = new Date(dayStart(day).getTime() - 86400000).toISOString().slice(0, 10);
        const prior = await tx.dailyQuoteEdition.findUnique({ where: { day: yesterday }, select: { quote: { select: { submitterId: true } } } });
        const community = candidates.find((row) => row.submitterId !== prior?.quote.submitterId) ?? candidates[0];
        let quoteId: string;
        if (community) {
          // 条件写入 + edition 同事务：不能跨日重复认领，失败也不能把稿件凭空用掉。
          const claimed = await tx.dailyQuote.updateMany({
            where: { id: community.id, status: 'approved', firstSelectedDay: null, editions: { none: {} } },
            data: { firstSelectedDay: day },
          });
          if (!claimed.count) throw new QuoteError(409, '选登状态变化，请重试', 'SELECTION_CHANGED');
          quoteId = community.id;
        } else {
          const classics = await tx.dailyQuote.findMany({ where: { kind: 'builtin', status: 'approved' }, select: { id: true } });
          if (!classics.length) throw new QuoteError(503, '今日暂无可用的一言，请稍后再试');
          const used = await tx.dailyQuoteEdition.groupBy({ by: ['quoteId'],
            where: { quoteId: { in: classics.map((q) => q.id) }, day: { lt: day } }, _max: { day: true } });
          const last = new Map(used.map((row) => [row.quoteId, row._max.day ?? '']));
          const oldest = classics.reduce((min, q) => (last.get(q.id) ?? '') < min ? (last.get(q.id) ?? '') : min, '9999-12-31');
          const pool = classics.filter((q) => (last.get(q.id) ?? '') === oldest);
          quoteId = pool[randomInt(pool.length)].id;
        }
        await tx.dailyQuoteEdition.create({ data: { day, quoteId, createdAt: nowForDb() } });
        return quoteId;
      });
    } catch (error) {
      if (uniqueViolation(error) || (error as { code?: string })?.code === 'P2034' ||
        (error instanceof QuoteError && error.reason === 'SELECTION_CHANGED')) {
        const winner = await prisma.dailyQuoteEdition.findUnique({ where: { day } });
        if (winner) return winner.quoteId;
        if (attempt < 2) continue;
      }
      throw error;
    }
  }
  throw new QuoteError(503, '选登暂时繁忙，请稍后重试');
}

async function editionQuoteId(day: string): Promise<string> {
  const pending = state.__dailyQuotePending.get(day);
  if (pending) return pending;
  const operation = selectEdition(day);
  state.__dailyQuotePending.set(day, operation);
  try { return await operation; }
  finally { state.__dailyQuotePending.delete(day); }
}

/** 今日入口的四种状态（页面与 API 共用；客户端按它决定文案）。 */
export interface TodayQuoteResult {
  day: string;
  state: TodayQuoteState;
  /** 只有 `published` 非空；其余状态用页面文案说明（下架/未发行/发行失败）。 */
  quote: DailyQuoteView | null;
  can_submit: boolean;
}

export interface EditionIssueResult {
  day: string;
  status: 'published' | 'failed';
  quoteId?: string;
  error?: string;
}

/** 当天发行失败记录（进程内）；无记录返回 null。 */
export function dailyQuoteIssuanceFailure(day: string): { at: number; error: string } | null {
  return state.__dailyQuoteIssuance!.failures.get(day) ?? null;
}

/** 仅供测试：清空进程内发行状态（失败记录 / 定时器标记），避免用例互相影响。 */
export function __resetDailyQuoteIssuanceState(): void {
  const store = state.__dailyQuoteIssuance!;
  store.failures.clear();
  store.lastDay = null;
}

/**
 * 幂等发行某一天的每日一言。
 *
 * 生产调用方只有启动钩子与跨日定时器，且**只传当天**（`todayStr()`）：停机漏掉的
 * 旧期不会在这里被回填 —— 非当天请求直接拒绝，不产生任何 edition。
 * 已有记录直接复用（重复调度 / 当天重启 / 多进程并发都得到同一天同一句）。
 * 选句失败只记录失败态并返回，不抛给启动钩子（进程不能因为附加功能起不来）。
 */
export async function ensureEditionForDay(day: string): Promise<EditionIssueResult> {
  const store = state.__dailyQuoteIssuance!;
  const today = todayStr();
  if (day !== today) {
    const error = `只允许发行当天（请求 ${day}，当天 ${today}）`;
    console.warn('[daily-quote]', error);
    return { day, status: 'failed', error };
  }
  try {
    const quoteId = await editionQuoteId(day);
    store.failures.delete(day);
    store.lastDay = day;
    return { day, status: 'published', quoteId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.failures.set(day, { at: Date.now(), error: message });
    // 只记诊断，不打印正文；失败态由 getTodayQuote 转成 `failed`。
    console.error('[daily-quote] 当天发行失败（下一次调度会重试）:', day, message);
    return { day, status: 'failed', error: message };
  }
}

/**
 * 启动每日发行：启动时确保当天有发行；之后每分钟检查一次北京日期，跨日发行新一天。
 *
 * 只由 `src/instrumentation.ts` 在 nodejs runtime 调用。以下情况直接不启动：
 * 构建期、测试环境（vitest 会 import 本模块，绝不能起后台循环）、显式关闭。
 * 热更新可能重复调用 register()，用 globalThis 标记保证同进程只起一个定时器。
 */
export function startDailyQuotePublisher(): void {
  if (
    process.env.NEXT_RUNTIME !== 'nodejs' ||
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST ||
    process.env.DAILY_QUOTE_PUBLISHER === 'off'
  ) {
    return;
  }
  const store = state.__dailyQuoteIssuance!;
  if (store.started) return;
  store.started = true;

  const tick = async (): Promise<void> => {
    const today = todayStr();
    // 同一天已确认发行则跳过；失败的日子每个 tick 都会重试（幂等）。
    if (store.lastDay === today && !store.failures.has(today)) return;
    await ensureEditionForDay(today);
  };
  void tick();
  store.timer = setInterval(() => void tick(), 60_000);
  // 不影响脚本/测试进程退出（服务进程本来常驻，这里只是好习惯）。
  store.timer.unref?.();
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
  const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true, banUntil: true } });
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
    if (isCurrentlyBanned(viewer)) unavailable = '禁言期间暂时无法操作';
    else if (quote.submitterId === userId) unavailable = '不能给自己的投稿共鸣';
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
      resonance_fish: quote.kind === 'community' && canReceive(submitter) ? QUOTE_RESONANCE_FISH : 0,
      // 终身资格：已共鸣之后按钮永远不可再点（不提供取消，也没有「明天再来」）。
      can_resonate: !unavailable && !resonatedOnce,
      can_favorite: !isCurrentlyBanned(viewer),
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

/**
 * 今日一言：**纯读**当天已发行的记录，绝不在这里选句（P03）。
 *
 * 状态区分（页面 / API 共用）：
 *   · `published`   有发行记录且有可展示正文；
 *   · `pending`     当天还没有发行记录（服务刚恢复、定时器还没跑到）；
 *   · `failed`      当天发行失败（进程内记录；重启 / 下一次调度会重试）；
 *   · `unavailable` 有发行记录但内容已下架 / 投稿人归档 / 审核状态变化。
 * 后三种 `quote` 为 null —— 历史记录与当天占位都保留，不会重新抽取。
 */
export async function getTodayQuote(userId: string): Promise<TodayQuoteResult> {
  const actor = await requireQuoteParticipant(userId);
  const day = todayStr();
  // P02（2026-11-07）：查看今日一言**不再要求当天已签到** —— 未归档 core+ 直接可读；
  // 状态仍由发行记录决定（pending / failed / unavailable / published，P03 层）。
  const can_submit = !isCurrentlyBanned(actor);

  const edition = await prisma.dailyQuoteEdition.findUnique({ where: { day }, select: { quoteId: true } });
  if (!edition) {
    const failed = dailyQuoteIssuanceFailure(day);
    return { day, state: failed ? 'failed' : 'pending', quote: null, can_submit };
  }
  const quote = await prisma.dailyQuote.findFirst({
    where: { id: edition.quoteId, status: 'approved', ...activeSubmitter },
  });
  if (!quote) return { day, state: 'unavailable', quote: null, can_submit };
  return { day, state: 'published', quote: await quoteView(quote, userId), can_submit };
}

async function publishedQuote(quoteId: string, userId: string, tx: Prisma.TransactionClient = prisma) {
  const day = todayStr();
  // P02：历史与今日的已发行一言都直接可读（原实现用「今天签到过没有」在 lte/lt 之间
  // 切换，等于把签到当成今日可见性的门；签到与一言阅读已解耦）。
  const quote = await tx.dailyQuote.findFirst({
    where: { id: quoteId, status: 'approved', editions: { some: { day: { lte: day } } }, ...activeSubmitter },
  });
  if (!quote) throw new QuoteError(404, '一言不存在或已下架');
  return quote;
}

/**
 * 参与资格（P02 起）：**未归档 core+**；写了就按禁言拦，审批还要求管理权限。
 *
 * 2026-11-07 产品决定取消了「名下有未删除博客」这条门（读者/投稿人/候选池都不再
 * 因没发过文章受限）。别再把它加回来 —— 这条门曾让零博客成员连今日一言都读不了。
 */
export async function requireQuoteParticipant(userId: string, options: { write?: boolean; admin?: boolean } = {}, tx: Prisma.TransactionClient = prisma) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: {
    id: true, role: true, archivedAt: true, isBanned: true, banUntil: true, driedFish: true,
  } });
  if (!user || !isCoreUser(user)) throw new QuoteError(403, '需要核心用户权限');
  // 管理操作按「管理权限」判（hasAdminRights 含 owner/admin 且排除归档），别自造角色表。
  if (options.admin && !hasAdminRights(user)) throw new QuoteError(403, '需要管理员权限');
  if (options.write && isCurrentlyBanned(user)) throw new QuoteError(403, '禁言期间暂时无法操作', 'BANNED');
  return user;
}

function canReceive(user: { role?: string; archivedAt?: Date | null; isBanned?: boolean | null; banUntil?: Date | null } | null) {
  return isCoreUser(user) && !isCurrentlyBanned(user);
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
function resonanceResult(already: boolean, resonanceCount: number, balance: number, chargedFish = 0): DailyQuoteResonanceResult {
  return {
    already_resonated: already,
    charged_fish: chargedFish,
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
export async function resonateQuote(quoteId: string, userId: string, maxFish: unknown): Promise<DailyQuoteResonanceResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const actor = await requireQuoteParticipant(userId, { write: true }, tx);
      const quote = await publishedQuote(quoteId, userId, tx);
      const prior = await tx.dailyQuoteResonanceOnce.findUnique({
        where: { uq_daily_quote_resonance_once: { quoteId, userId } }, select: { quoteId: true },
      });
      if (prior) return resonanceResult(true, await resonanceCountOf(quoteId, tx), unitsToFish(actor.driedFish));
      if (quote.submitterId === userId) throw new QuoteError(400, '不能给自己的投稿共鸣');

      if (maxFish !== 0 && maxFish !== 1) throw new QuoteError(400, '请刷新后确认共鸣费用', 'FEE_REQUIRED');
      const recipient = quote.submitterId ? await tx.user.findUnique({ where: { id: quote.submitterId }, select: submitterSelect }) : null;
      const fee = quote.kind === 'community' && canReceive(recipient) ? QUOTE_RESONANCE_FISH : 0;
      if (fee > maxFish) throw new QuoteError(409, '共鸣费用已变化，请刷新后再次点击', 'FEE_CHANGED', { resonance_fish: fee });
      const paidUnits = fishToUnits(fee);

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
      return resonanceResult(false, await resonanceCountOf(quoteId, tx), unitsToFish(actor.driedFish - paidUnits), fee);
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
  return prisma.$transaction(async (tx) => {
    await requireQuoteParticipant(userId, { write: true }, tx);
    if (saved) await publishedQuote(quoteId, userId, tx);
    const previous = saved ? await tx.dailyQuoteFavorite.findUnique({ where: { uq_daily_quote_favorite: { userId, quoteId } } }) : null;
    // 网络重试不会改写收藏时间；仅首次加入或取消后重新加入记为新的收藏。
    if (previous && !previous.deleted) return;
    // 移出收藏也允许作用于下架内容，以免私密分类里留下无法清理的条目。
    if (saved) await tx.dailyQuoteFavorite.upsert({
      where: { uq_daily_quote_favorite: { userId, quoteId } },
      create: { userId, quoteId, createdAt: nowForDb() },
      update: { deleted: false, deletedAt: null, createdAt: nowForDb() },
    });
    else await tx.dailyQuoteFavorite.updateMany({
      where: { userId, quoteId, deleted: false }, data: { deleted: true, deletedAt: nowForDb() },
    });
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
  await requireQuoteParticipant(userId);
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
 * 收藏时间与首次选登日期分开；经典重播不改变收藏时间，也不透露今日期次。
 * 下架内容保留占位（`quote: null`）与日期，仍可移出
 * —— 否则私密分类里会留下无法清理的条目。
 *
 * 页码按 `normalizeQuotePage` 收敛：取消末页最后一条后再刷新会回到有效末页。
 */
export async function listSavedQuotes(
  userId: string,
  page = 1,
): Promise<{ total: number; page: number; pages: number; quotes: SavedQuoteEntry[] }> {
  await requireQuoteParticipant(userId);
  const where: Prisma.DailyQuoteFavoriteWhereInput = { userId, deleted: false };
  const total = await prisma.dailyQuoteFavorite.count({ where });
  const { page: currentPage, pages } = normalizeQuotePage(page, total, QUOTE_SAVED_PAGE_SIZE);
  if (total === 0) return { total, page: currentPage, pages, quotes: [] };

  const rows = await prisma.dailyQuoteFavorite.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { quoteId: 'asc' }],
    skip: (currentPage - 1) * QUOTE_SAVED_PAGE_SIZE,
    take: QUOTE_SAVED_PAGE_SIZE,
    select: { quoteId: true, createdAt: true },
  });
  const quoteIds = rows.map((row) => row.quoteId);
  const [quotes, lastDays] = await Promise.all([
    prisma.dailyQuote.findMany({ where: { id: { in: quoteIds }, status: 'approved', ...activeSubmitter } }),
    prisma.dailyQuoteEdition.groupBy({ by: ['quoteId'], where: { quoteId: { in: quoteIds } }, _min: { day: true } }),
  ]);
  const views = await buildQuoteViews(quotes, userId);
  const firstDayByQuote = new Map(lastDays.map((row) => [row.quoteId, row._min.day ?? null]));
  const entries: SavedQuoteEntry[] = rows.map((row) => ({
    id: row.quoteId,
    saved_at: row.createdAt.toISOString(),
    first_selected_day: firstDayByQuote.get(row.quoteId) ?? null,
    quote: views.get(row.quoteId) ?? null,
  }));
  return { total, page: currentPage, pages, quotes: entries };
}

function consumeSubmissionQuota(userId: string) {
  const gate = rateLimit(`quote:submit:${userId}`, RULES.quoteSubmitDaily);
  if (!gate.allowed) throw new QuoteError(429, '今日投稿次数已用完，请明天再来');
}

function validateSubmission(input: Record<string, unknown>) {
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
  return {
    content: text, contentKey: quoteContentKey(text), category: category as string, signature,
    sourceType: source_type, sourceName: source_type === 'quotation' ? source : null,
  };
}

function revisionData(quote: DailyQuote) {
  return { quoteId: quote.id, revision: quote.revision, content: quote.content, category: quote.category,
    signature: quote.signature, sourceType: quote.sourceType, sourceName: quote.sourceName,
    status: quote.status, reviewReason: quote.reviewReason, reviewerId: quote.reviewerId,
    reviewedAt: quote.reviewedAt, createdAt: nowForDb() };
}

async function createSubmission(userId: string, data: ReturnType<typeof validateSubmission>, tx: Prisma.TransactionClient) {
  const quote = await tx.dailyQuote.create({ data: {
    ...data, id: randomUUID(), kind: 'community', submitterId: userId,
    status: 'pending', createdAt: nowForDb(),
  } });
  await tx.dailyQuoteRevision.create({ data: revisionData(quote) });
  return { id: quote.id, status: quote.status, version: quote.revision };
}

export async function submitQuote(userId: string, input: Record<string, unknown>) {
  try {
    return await prisma.$transaction(async (tx) => {
      await requireQuoteParticipant(userId, { write: true }, tx);
      const data = validateSubmission(input);
      consumeSubmissionQuota(userId);
      return createSubmission(userId, data, tx);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new QuoteError(409, '这句内容正在审核或已收录，不能重复投稿', 'DUPLICATE_CONTENT');
    throw error;
  }
}

/**
 * 待审编辑及未通过重审都沿用原 ID，新增不可覆盖的版本。只修元信息也可以重新送审。
 * 权限、状态复核与写入放在同一事务，审核先完成时保存必须失败，不能改写已通过的正文。
 */
export async function editQuoteSubmission(quoteId: string, userId: string, input: Record<string, unknown>) {
  try {
    return await prisma.$transaction(async (tx) => {
      await requireQuoteParticipant(userId, { write: true }, tx);
      const quote = await tx.dailyQuote.findFirst({ where: { id: quoteId, submitterId: userId, kind: 'community' } });
      if (!quote) throw new QuoteError(404, '投稿不存在');
      if (!canEditQuoteSubmission(quote.status)) throw new QuoteError(409, '稿件已通过审核或已下架，不能编辑，请刷新');
      const data = validateSubmission(input);
      if (input.version !== undefined && input.version !== quote.revision) throw new QuoteError(409, '稿件版本已变化，请刷新后编辑', 'VERSION_CHANGED');
      const changed = data.content !== quote.content || data.category !== quote.category || data.signature !== quote.signature ||
        data.sourceType !== quote.sourceType || data.sourceName !== quote.sourceName;
      if (!changed && quote.status === 'rejected') throw new QuoteError(400, '请先修改稿件后重新提交', 'CHANGE_REQUIRED');
      if (!changed) return { id: quoteId, status: quote.status, version: quote.revision };
      if (quote.status === 'rejected') consumeSubmissionQuota(userId);
      // 保全旧版本，包括旧库或运维导入的记录，不能在重审时覆盖旧审核意见。
      await tx.dailyQuoteRevision.upsert({ where: { quoteId_revision: { quoteId, revision: quote.revision } },
        create: revisionData(quote), update: {} });
      const updated = await tx.dailyQuote.updateMany({
        where: { id: quoteId, submitterId: userId, kind: 'community', status: quote.status, revision: quote.revision },
        data: { ...data, revision: { increment: 1 }, status: 'pending', reviewerId: null, reviewedAt: null, reviewReason: null },
      });
      if (!updated.count) throw new QuoteError(409, '稿件状态已变化，请刷新');
      const current = await tx.dailyQuote.findUniqueOrThrow({ where: { id: quoteId } });
      await tx.dailyQuoteRevision.create({ data: revisionData(current) });
      return { id: quoteId, status: 'pending', version: current.revision };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new QuoteError(409, '这句内容正在审核或已收录，不能重复投稿', 'DUPLICATE_CONTENT');
    throw error;
  }
}

export async function listSubmissions(userId: string) {
  await requireQuoteParticipant(userId);
  const quotes = await prisma.dailyQuote.findMany({
    where: { submitterId: userId, kind: 'community' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100,
    select: { id: true, content: true, category: true, signature: true, sourceType: true, sourceName: true, status: true,
      revision: true, firstSelectedDay: true, reviewReason: true, createdAt: true,
      revisions: { orderBy: { revision: 'desc' }, select: { revision: true, content: true, category: true, signature: true,
        sourceType: true, sourceName: true, status: true, reviewReason: true, reviewedAt: true, createdAt: true, isBaseline: true } } },
  });
  return quotes.map((quote) => ({ ...quote, display_status: quoteDisplayStatus(quote), version: quote.revision }));
}

export async function listReviewQuotes(status: string, page: number, adminId: string) {
  await requireQuoteParticipant(adminId, { admin: true });
  const selected = (QUOTE_STATUSES as readonly string[]).includes(status) ? status : 'pending';
  const current = Number.isSafeInteger(page) ? Math.max(1, page) : 1;
  const where: Prisma.DailyQuoteWhereInput = { ...activeSubmitter,
    ...(selected === 'builtin' ? { kind: 'builtin', status: 'approved' } : selected === 'retired' ? { status: 'retired' } :
      { kind: 'community', status: selected === 'selected' ? 'approved' : selected,
        ...(selected === 'approved' ? { firstSelectedDay: null } : selected === 'selected' ? { firstSelectedDay: { not: null } } : {}) }) };
  const [total, quotes] = await Promise.all([
    prisma.dailyQuote.count({ where }),
    prisma.dailyQuote.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (current - 1) * 30, take: 30,
      include: { submitter: { select: { username: true, role: true, isBanned: true, banUntil: true } },
        revisions: { orderBy: { revision: 'desc' } } },
    }),
  ]);
  return { total, page: current, pages: Math.ceil(total / 30), status: selected, quotes: quotes.map((quote) => ({ ...quote,
    display_status: quoteDisplayStatus(quote),
    // P02（2026-11-07）：候选池不再看「投稿人名下有几篇未删除博客」；只剩账号状态两条
    // （降权 / 禁言），管理员按权限照常可审。
    candidate_unavailable: quote.kind !== 'community' || quote.status !== 'approved' || quote.firstSelectedDay ? null :
      !isCoreUser(quote.submitter) ? '投稿人当前不是核心用户，暂停候选' : isCurrentlyBanned(quote.submitter) ? '投稿人当前被禁言，暂停候选' : null })) };
}

/** 审核页面所见的可编辑字段快照；署名与来源变化同样需要重新确认。 */
export function quoteReviewVersion(quote: Pick<DailyQuote, 'revision' | 'content' | 'category' | 'signature' | 'sourceType' | 'sourceName'>): string {
  return createHash('sha256').update(JSON.stringify([
    quote.revision, quote.content, quote.category, quote.signature, quote.sourceType, quote.sourceName,
  ])).digest('hex');
}

export async function reviewQuote(quoteId: string, adminId: string, action: unknown, reason: unknown, expectedVersion?: string) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!['approve', 'reject', 'retire'].includes(action as string)) throw new QuoteError(400, '审核操作无效');
  if (quoteLength(trimmed) > 200 || (action !== 'approve' && !trimmed)) throw new QuoteError(400, '请填写200字以内的原因');
  const expected = action === 'retire' ? 'approved' : 'pending';
  const next = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'retired';
  await prisma.$transaction(async (tx) => {
    await requireQuoteParticipant(adminId, { write: true, admin: true }, tx);
    const quote = await tx.dailyQuote.findFirst({ where: { id: quoteId, status: expected, ...activeSubmitter } });
    if (!quote) throw new QuoteError(409, '稿件状态已变化，请刷新后重新审核');
    if (expectedVersion !== undefined && quoteReviewVersion(quote) !== expectedVersion) {
      throw new QuoteError(409, '稿件已被作者修改，请刷新后重新审核', 'VERSION_CHANGED');
    }
    const updated = await tx.dailyQuote.updateMany({
      where: { id: quoteId, status: expected, revision: quote.revision }, data: { status: next, reviewReason: trimmed || null, reviewerId: adminId, reviewedAt: nowForDb() },
    });
    if (!updated.count) throw new QuoteError(409, '稿件状态已变化，请刷新');
    if (action !== 'retire') await tx.dailyQuoteRevision.upsert({ where: { quoteId_revision: { quoteId, revision: quote.revision } },
      create: { ...revisionData(quote), status: next, reviewerId: adminId, reviewReason: trimmed || null, reviewedAt: nowForDb() },
      update: { status: next, reviewerId: adminId, reviewReason: trimmed || null, reviewedAt: nowForDb() } });
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
