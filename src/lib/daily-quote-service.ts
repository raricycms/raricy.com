// 每日一言：全站 UTC+8 每日固定一句，社区优先，90天内不重新选用同一内容。
// 签到到账与一言读取独立：展示失败不能回滚签到，也不能改变当天已选定的一句。
// 共鸣以 (quote,user,day) 去重，和两侧 postEntry 同事务；匿名不向付款方暴露收款人。
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { DailyQuote, Prisma } from '@prisma/client';
import { prisma } from './db';
import { dayStart, nowForDb, todayStr } from './db-time';
import { hasAdminRights, isCoreUser, isCurrentlyBanned } from './auth';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { rateLimit, RULES } from './rate-limit';
import {
  QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, QUOTE_NO_REPEAT_DAYS, QUOTE_RESONANCE_FISH,
  QUOTE_STATUSES, quoteLength, type DailyQuoteView,
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

// 归属判断留在服务端，只传 can_resonate；匿名时所有普通出口都不带 submitterId。
export async function quoteView(quote: DailyQuote, userId: string, day = todayStr()): Promise<DailyQuoteView> {
  const [submitter, resonated, favorite, count] = await Promise.all([
    quote.submitterId ? prisma.user.findUnique({ where: { id: quote.submitterId }, select: {
      id: true, username: true, role: true, archivedAt: true, isBanned: true, banUntil: true,
    } }) : null,
    prisma.dailyQuoteResonance.findUnique({ where: { uq_daily_quote_resonance: { quoteId: quote.id, userId, day } } }),
    prisma.dailyQuoteFavorite.findUnique({ where: { uq_daily_quote_favorite: { userId, quoteId: quote.id } } }),
    prisma.dailyQuoteResonance.count({ where: { quoteId: quote.id } }),
  ]);
  let unavailable: string | null = null;
  if (quote.submitterId === userId) unavailable = '不能给自己的投稿共鸣';
  else if (quote.kind === 'community' && (!submitter || !isCoreUser(submitter) || isCurrentlyBanned(submitter))) {
    unavailable = '投稿人当前无法接收投喂';
  }
  const name = quote.kind === 'builtin' ? quote.authorName ?? '佚名'
    : quote.signature === 'anonymous' ? '匿名' : submitter?.username ?? '已注销用户';
  return {
    id: quote.id, content: quote.content, category: quote.category, kind: quote.kind,
    author: name, source_type: quote.sourceType, source_name: quote.sourceName, source_url: quote.sourceUrl,
    submitter_name: quote.kind === 'community' ? name : null,
    resonance_count: count, resonated: Boolean(resonated), favorited: Boolean(favorite && !favorite.deleted),
    resonance_fish: quote.kind === 'community' ? QUOTE_RESONANCE_FISH : 0,
    can_resonate: !unavailable && !resonated, resonance_unavailable: unavailable,
  };
}

export async function getTodayQuote(userId: string) {
  const day = todayStr();
  if (!(await checkedIn(userId, day))) throw new QuoteError(403, '完成今日签到后可查看每日一言');
  const id = await editionQuoteId(day);
  const quote = await prisma.dailyQuote.findFirst({ where: { id, status: 'approved', ...activeSubmitter } });
  // 下架不重新抽取，避免同一天不同人看到两句；保留当天占位及历史选择记录。
  return { day, quote: quote ? await quoteView(quote, userId, day) : null };
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

export async function resonateQuote(quoteId: string, userId: string) {
  const day = todayStr();
  try {
    return await prisma.$transaction(async (tx) => {
      const actor = await requireActor(userId, tx);
      const quote = await publishedQuote(quoteId, tx);
      const prior = await tx.dailyQuoteResonance.findUnique({
        where: { uq_daily_quote_resonance: { quoteId, userId, day } },
      });
      if (prior) return { already_resonated: true, balance: unitsToFish(actor.driedFish) };
      if (quote.submitterId === userId) throw new QuoteError(400, '不能给自己的投稿共鸣');
      const paidUnits = quote.kind === 'community' ? fishToUnits(QUOTE_RESONANCE_FISH) : 0;
      await tx.dailyQuoteResonance.create({ data: { quoteId, userId, day, paidUnits, createdAt: nowForDb() } });
      if (paidUnits) {
        if (!quote.submitterId) throw new QuoteError(400, '投稿人当前无法接收投喂');
        await requireActor(quote.submitterId, tx);
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
      return { already_resonated: false, balance: unitsToFish(actor.driedFish - paidUnits) };
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      const prior = await prisma.dailyQuoteResonance.findUnique({ where: { uq_daily_quote_resonance: { quoteId, userId, day } } });
      if (prior) return { already_resonated: true };
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

export async function listSavedQuotes(userId: string, page = 1) {
  const currentPage = Number.isSafeInteger(page) ? Math.max(1, page) : 1;
  const where = { userId, deleted: false };
  const [total, rows] = await Promise.all([
    prisma.dailyQuoteFavorite.count({ where }),
    prisma.dailyQuoteFavorite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (currentPage - 1) * 20, take: 20 }),
  ]);
  const quotes = await Promise.all(rows.map(async (row) => {
    const quote = await prisma.dailyQuote.findFirst({ where: { id: row.quoteId, status: 'approved', ...activeSubmitter } });
    return { id: row.quoteId, quote: quote ? await quoteView(quote, userId) : null };
  }));
  return { total, page: currentPage, pages: Math.ceil(total / 20), quotes };
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
