// 客户端与服务端共用的每日一言词表、长度与展示契约；不引入数据库或 Node 模块。
export const QUOTE_CONTENT_MAX = 50;
export const QUOTE_NO_REPEAT_DAYS = 90;
export const QUOTE_RESONANCE_FISH = 1;
export const QUOTE_HISTORY_PAGE_SIZE = 20;
export const QUOTE_SAVED_PAGE_SIZE = 20;
export const QUOTE_CATEGORIES = ['治愈', '搞笑', '扎心', '励志', '哲思'] as const;
export const QUOTE_STATUSES = ['pending', 'approved', 'rejected', 'retired'] as const;
export const QUOTE_STATUS_LABELS: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已拒绝', retired: '已下架',
};

/**
 * 一条一言对某个查看者的完整展示状态。
 *
 * 【`resonated` 的语义是「一生一次」，不是「今天」】2026-10 起资格由
 * `daily_quote_resonance_once` 决定：换日、取消收藏、90 天后再次入选都不会重置。
 * 因此这个字段**不需要日期上下文**，历史列表与今日弹窗拿到的是同一个真值。
 */
export interface DailyQuoteView {
  id: string;
  content: string;
  category: string;
  kind: string;
  author: string;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  submitter_name: string | null;
  resonance_count: number;
  resonated: boolean;
  favorited: boolean;
  resonance_fish: number;
  can_resonate: boolean;
  resonance_unavailable: string | null;
}

/**
 * 往期一言的一条 = 某个 UTC+8 日历日实际选用过的一期。
 *
 * `quote` 为 null 表示**这一期确实存在，但内容已不可展示**（下架 / 作者归档）——
 * 日期必须保留，不能把整条从列表里抹掉：那是「那天有过一言」的唯一痕迹。
 */
export interface DailyQuoteHistoryEntry {
  day: string;
  quote: DailyQuoteView | null;
}

/** 一言集的一条：`last_day` 是最近一次入选日期（不是收藏时间）。 */
export interface SavedQuoteEntry {
  id: string;
  last_day: string | null;
  quote: DailyQuoteView | null;
}

/**
 * 共鸣接口的权威响应。
 *
 * 【客户端不许自己 +1】两个标签页都点过共鸣、或服务端因累计资格返回「已共鸣」时，
 * 本地推算的 `resonance_count + 1` 是错的。人数与按钮状态一律以这个响应为准。
 */
export interface DailyQuoteResonanceResult {
  /** 本次请求是否命中「早已共鸣过」（幂等重放）。 */
  already_resonated: boolean;
  resonated: boolean;
  can_resonate: boolean;
  resonance_count: number;
  resonance_unavailable: string | null;
  /** 本次操作后的余额；命中幂等重放时是当前余额。 */
  balance?: number;
}

export function quoteLength(content: string): number {
  return Array.from(content).length;
}

/** 分页收敛：非正整数退回第一页，超过末页归一到有效末页；空集为 `page=1, pages=0`。 */
export function normalizeQuotePage(requested: number, total: number, pageSize: number) {
  const pages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const wanted = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  return { page: pages > 0 ? Math.min(wanted, pages) : 1, pages };
}
