'use client';

// ─────────────────────────────────────────────────────────────────────────────
// OnlineRoomPanel.tsx — 联机棋类的房间面板与专注模式占位（五子棋 / 井字棋共用）
//
// 【为什么共用】「创建房间 / 输入房号加入 / 显示错误」这三件事对所有联机棋类
// 一字不差 —— 各写一份的话，房号输入框的 maxLength、回车提交、错误行样式这些
// 细节会在两个游戏之间悄悄分叉（而这正是「同一个站里两个入口手感不一样」的来源）。
//
// 【类名是 online-room-* 而不是 gomoku-*】因为这些 chrome 本来就不属于任何一款棋。
// 棋盘、状态文案、控制按钮仍留在各游戏自己的组件里，用各自的命名空间。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { FOCUS_MODE_SETTINGS_HREF } from '@/lib/focus-mode';

export interface OnlineRoomPanelProps {
  title: string;
  desc: string;
  joinCode: string;
  onJoinCodeChange: (value: string) => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  busy: boolean;
  error: string | null;
  /** 加入按钮的文案，默认「加入」。 */
  joinLabel?: string;
  /** 房号输入框的占位文案，默认「输入 6 位房号」。 */
  joinPlaceholder?: string;
}

export default function OnlineRoomPanel({
  title,
  desc,
  joinCode,
  onJoinCodeChange,
  onCreate,
  onJoin,
  busy,
  error,
  joinLabel = '加入',
  joinPlaceholder = '输入 6 位房号',
}: OnlineRoomPanelProps) {
  return (
    <div className="board-card board-room-panel">
      <h2 className="board-room-panel__title">{title}</h2>
      <p className="board-room-panel__desc">{desc}</p>

      <button
        type="button"
        className="board-btn board-btn--primary"
        onClick={onCreate}
        disabled={busy}
      >
        创建房间
      </button>

      <div className="board-room-panel__join">
        <input
          className="board-room-panel__input"
          value={joinCode}
          onChange={(e) => onJoinCodeChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onJoin(joinCode);
          }}
          placeholder={joinPlaceholder}
          maxLength={12}
          aria-label="房号"
        />
        <button
          type="button"
          className="board-btn"
          onClick={() => onJoin(joinCode)}
          disabled={busy || !joinCode.trim()}
        >
          {joinLabel}
        </button>
      </div>

      {error && <p className="board-room-panel__error">{error}</p>}
    </div>
  );
}

/**
 * 专注模式下的占位（页面层用它，避免进房面板闪一下）。
 * 文案与联机闸门一致：服务端此时是硬 403，这里要给的不是「禁止」而是「怎么关」。
 */
export function OnlineFocusLock() {
  return (
    <div className="board-card">
      <div className="game-card game-card--locked game-card--focus-lock">
        <div className="game-card__body">
          <h3 className="game-card__title">已开启专注模式</h3>
          <p className="game-card__desc">
            联机对战是社交玩法，「玩具」暂不可用。可在设置中随时关闭专注模式。
          </p>
          <Link className="game-card__btn game-card__btn--link" href={FOCUS_MODE_SETTINGS_HREF}>
            前往设置关闭
          </Link>
        </div>
      </div>
    </div>
  );
}
