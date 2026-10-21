// ─────────────────────────────────────────────────────────────────────────────
// session.ts — 一局游戏的纯状态机（容器组件只负责「把事件喂进来、把副作用发出去」）
//
// 为什么要拆出这一层：一局里同时有四件事在变（棋盘状态、撤销栈、提示/提示文案、
// 通关标记），而它们必须**一起**变。散在 useState 里，键盘连按两次时第二下会读到
// 上一次渲染的旧状态 —— 症状是「按得快点，偶尔丢一步」，而且只在慢机器上偶发。
// 写成 reducer，所有变化都在同一次更新里完成，副作用（音效 / 存档 / 弹层）交给
// effect 按 `serial` 与 `last` 触发，于是「按键快慢」不再影响结果。
// ─────────────────────────────────────────────────────────────────────────────

import { initialState, resolveMove } from './engine';
import { blockedText, type BlockReason, type CompiledLevel, type Dir, type GameState, type MoveEvents } from './types';
import type { StatusLine } from './ui-types';

/** 上一次动作的种类。音效与状态行只按它分支，不再各自去嗅探状态差异。 */
export type SessionActionKind = 'none' | 'move' | 'blocked' | 'undo' | 'restart' | 'load' | 'hint';

export interface Session {
  readonly levelIndex: number;
  readonly state: GameState;
  /** 最近一次「走成了」的事件；撤销 / 重来 / 换关后为 null。 */
  readonly events: MoveEvents | null;
  /** 每次有变化就 +1：渲染层拿它重播一次性动画，effect 拿它触发音效。 */
  readonly serial: number;
  readonly history: readonly GameState[];
  readonly blocked: { readonly a: BlockReason | null; readonly b: BlockReason | null } | null;
  readonly status: StatusLine;
  readonly solved: boolean;
  readonly last: SessionActionKind;
}

export type SessionAction =
  | { readonly type: 'move'; readonly dir: Dir }
  | { readonly type: 'undo' }
  | { readonly type: 'restart' }
  | { readonly type: 'load'; readonly index: number }
  /** 提示：文案由调用方给（关卡作者写的那句），dir 为 null 表示「当前局面已经走不通」。 */
  | { readonly type: 'hint'; readonly text: string; readonly dir: Dir | null }
  /**
   * 「被挡住」的闪红到点了，把标记收回去。
   * 单独一个 action 而不是让组件自己定时改 state：闪红与状态行是同一份数据，
   * 分开存就会出现「字已经消失、红色还在」这种半截状态。
   */
  | { readonly type: 'blocked-clear' };

const IDLE: StatusLine = { text: '', tone: 'info' };

/** 进入某一关的初始会话。越界 index 会被夹回范围内（存档里的旧 id 可能已不存在）。 */
export function createSession(levels: readonly CompiledLevel[], index: number): Session {
  const safeIndex = levels.length === 0 ? 0 : Math.min(Math.max(index, 0), levels.length - 1);
  const level = levels[safeIndex];
  return {
    levelIndex: safeIndex,
    state: level ? initialState(level) : { a: 0, b: 0, blocks: [], moves: 0 },
    events: null,
    serial: 1,
    history: [],
    blocked: null,
    status: IDLE,
    solved: false,
    last: 'none',
  };
}

/** 撤销栈上限。手写关卡不会超过几十步，这里只是防御性上限（防止极端连按吃掉内存）。 */
const MAX_HISTORY = 400;

export function sessionReducer(levels: readonly CompiledLevel[], session: Session, action: SessionAction): Session {
  const level = levels[session.levelIndex];

  switch (action.type) {
    case 'load': {
      const next = createSession(levels, action.index);
      return { ...next, last: 'load', status: IDLE };
    }

    case 'restart': {
      if (!level) return session;
      return {
        ...session,
        state: initialState(level),
        events: null,
        serial: session.serial + 1,
        history: [],
        blocked: null,
        solved: false,
        status: { text: '回到这一关的起点', tone: 'info' },
        last: 'restart',
      };
    }

    case 'undo': {
      if (!level || session.history.length === 0 || session.solved) return session;
      const history = session.history.slice(0, -1);
      const previous = session.history[session.history.length - 1];
      return {
        ...session,
        state: previous,
        events: null,
        serial: session.serial + 1,
        history,
        blocked: null,
        // 撤销之后当然可以再通关，也可能又走成死局 —— 把 solved 重新算成 false。
        solved: false,
        status: { text: '撤销了一步', tone: 'info' },
        last: 'undo',
      };
    }

    case 'hint': {
      // 提示只改文案，不动棋盘。箭头（hintDir）是短命的展示态，住在组件里。
      return {
        ...session,
        serial: session.serial + 1,
        status: action.dir
          ? { text: action.text, tone: 'info' }
          : { text: '这个局面已经走不通了 —— 撤销或者重来吧', tone: 'warn' },
        last: 'hint',
      };
    }

    case 'blocked-clear':
      return session.blocked === null ? session : { ...session, blocked: null };

    case 'move': {
      if (!level || session.solved) return session;
      const outcome = resolveMove(level, session.state, action.dir);
      if (!outcome.ok) {
        return {
          ...session,
          serial: session.serial + 1,
          blocked: outcome.blocked,
          status: { text: blockedText(outcome.blocked), tone: 'warn' },
          last: 'blocked',
        };
      }
      const slid = outcome.events.selves.a.slide + outcome.events.selves.b.slide;
      return {
        ...session,
        state: outcome.state,
        events: outcome.events,
        serial: session.serial + 1,
        history: [...session.history, session.state].slice(-MAX_HISTORY),
        blocked: null,
        solved: outcome.solved,
        status: outcome.solved
          ? { text: '两盏灯都亮了', tone: 'good' }
          : slid > 0
            ? { text: '滑行只算一步', tone: 'info' }
            : IDLE,
        last: 'move',
      };
    }

    default:
      return session;
  }
}
