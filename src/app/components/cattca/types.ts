import type { PageMetrics } from './paginate';

export type ReaderMode = 'book' | 'single';

export type ReaderStatus = 'idle' | 'running' | 'ended' | 'error';

export interface ReaderSegment {
  /** 稳定 id；页 key 用它，避免重排后和别的段落串页。 */
  id: number;
  /** Markdown 渲染 + 消毒后的完整 HTML。 */
  html: string;
  /** 分页后的每页 HTML。 */
  pages: string[];
}

export interface ReaderPage {
  key: string;
  html: string;
  /** 全书页码（0 基）。 */
  globalIndex: number;
  segmentIndex: number;
  pageIndex: number;
  segmentId: number;
}

export interface ChoicePending {
  kind: 'choice';
  options: string[];
  resolve: (value: string) => void;
}

export interface InputPending {
  kind: 'input';
  name: string;
  resolve: (value: string) => void;
}

export type ReaderPending = ChoicePending | InputPending;

export interface ReaderProps {
  variant: 'story' | 'tool';
  status: ReaderStatus;
  pages: ReaderPage[];
  pageIndex: number;
  mode: ReaderMode;
  fullscreen: boolean;
  pending: ReaderPending | null;
  error: string | null;
  logs: string[];
  revealed: Set<string>;
  onModeChange: (mode: ReaderMode) => void;
  onToggleFullscreen: () => void;
  onPageChange: (index: number) => void;
  onPageRevealed: (pageKey: string) => void;
  onCompleteSegment: () => void;
  onJumpToPending: () => void;
  onChoose: (value: string) => void;
  onSubmitInput: (value: string) => void;
  onRestart: () => void;
  onMetricsChange: (metrics: PageMetrics) => void;
  onSpreadChange: (spread: boolean) => void;
}
