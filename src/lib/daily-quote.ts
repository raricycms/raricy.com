// 客户端与服务端共用的每日一言词表、长度与展示契约；不引入数据库或 Node 模块。
export const QUOTE_CONTENT_MAX = 50;
export const QUOTE_NO_REPEAT_DAYS = 90;
export const QUOTE_RESONANCE_FISH = 1;
export const QUOTE_CATEGORIES = ['治愈', '搞笑', '扎心', '励志', '哲思'] as const;
export const QUOTE_STATUSES = ['pending', 'approved', 'rejected', 'retired'] as const;
export const QUOTE_STATUS_LABELS: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已拒绝', retired: '已下架',
};

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

export function quoteLength(content: string): number {
  return Array.from(content).length;
}
