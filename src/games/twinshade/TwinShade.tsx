'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TwinShade.tsx — 双影的容器：把「输入 → 状态机 → 渲染 / 音效 / 存档」串起来
//
// 这一层刻意只做三件事：
//   1. 收输入（键盘 / 方向键 / 在棋盘上滑动），翻译成 session action；
//   2. 根据 session 的 serial / last 触发副作用（音效、存档、通关弹层、闪红回收）；
//   3. 把纯数据摆给展示组件（Board / Hud / Dpad / 三个浮层）。
// 规则判定一律在 engine.ts，状态迁移一律在 session.ts —— 这里不写 if 判断走不走得动。
//
// 另两条与体验直接相关的取舍：
//   · **键盘监听挂在 window 上**，所以点过页面任意位置就能玩；但输入框 / 可编辑区
//     里有焦点时一律放行（别抢用户打字的按键）；
//   · 存档只在**客户端挂载后**读（localStorage 在 SSR 期不存在）。挂载前先当「空存档」
//     渲染，挂载后再续上上次的关卡 —— 这样不会出现服务端与客户端 HTML 不一致的水合警告。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Board from './Board';
import Dpad from './Dpad';
import Hud from './Hud';
import LevelSelect from './LevelSelect';
import Onboarding from './Onboarding';
import Result from './Result';
import { createSound } from './audio';
import { compileLevel } from './engine';
import { LEVELS } from './levels';
import { loadProgress, recordClear, rememberLevel, saveProgress, setMuted as applyMuted, starsFor } from './progress';
import { createSession, sessionReducer, type Session, type SessionAction } from './session';
import { nextBestMove } from './solver';
import type { Dir } from './types';
import type { ProgressState, SoundHandle } from './ui-types';

/** 首帧（SSR 与客户端第一次渲染）都用这一份：内容必须与「没有存档」完全一致。 */
const EMPTY_PROGRESS: ProgressState = {
  version: 1,
  best: {},
  seenIntro: false,
  muted: false,
  lastLevelId: null,
};

/** 首次进入时从哪一关开始：续上次的关；否则第一个还没通关的关；都通关了就从第一关。 */
function resolveStartIndex(progress: ProgressState): number {
  if (progress.lastLevelId) {
    const index = LEVELS.findIndex((level) => level.id === progress.lastLevelId);
    if (index >= 0) return index;
  }
  const firstOpen = LEVELS.findIndex((level) => !(level.id in progress.best));
  return firstOpen >= 0 ? firstOpen : 0;
}

/** 键盘 → 方向。WASD 与方向键都给，因为两类玩家都存在。 */
const KEY_DIRS: Readonly<Record<string, Dir>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
  W: 'up',
  S: 'down',
  A: 'left',
  D: 'right',
};

/** 提示箭头亮多久（毫秒）。太长会盖住下一手，太短看不见 —— 1.8s 是手感的折中。 */
const HINT_VISIBLE_MS = 1800;
/** 被挡住时闪红的时长，与 scss 里 .tw-token--blocked 的动画时长保持一致。 */
const BLOCKED_FLASH_MS = 320;
/** 通关后停顿多久再弹结算（先让棋盘把「两盏灯亮起」演完）。 */
const RESULT_DELAY_MS = 560;

export default function TwinShade({ backHref = '/game', backLabel = '返回玩具' }: {
  backHref?: string;
  backLabel?: string;
}) {
  // 关卡只编译一次。编译期错误已在 tests/unit/twinshade-levels.test.ts 拦死；
  // 万一线上真出现坏数据，这里退化成「无可玩关卡」而不是整页白屏。
  const levels = useMemo(() => {
    try {
      return LEVELS.map((def) => compileLevel(def));
    } catch {
      return [];
    }
  }, []);

  const [session, dispatch] = useReducer(
    (state: Session, action: SessionAction) => sessionReducer(levels, state, action),
    levels,
    (initialLevels) => createSession(initialLevels, 0),
  );

  // ⚠️ 这里的初值**必须**是一份与 localStorage 无关的空存档，不能在 useState 的
  // 初始化函数里读存储：服务端渲染时 `window` 不存在（读到默认值），而客户端首帧
  // 直接读 localStorage（读到真存档）—— 两边的 HTML 就会因为「当前关是否已经通关」
  // 这类文案不同而水合失败（React #418，且只在「刷新一个已通关的关卡」时复现）。
  // 真存档一律在下面那个挂载 effect 里读进来。
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [hydrated, setHydrated] = useState(false);
  const [showLevels, setShowLevels] = useState(false);
  const [showOnboard, setShowOnboard] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [hintDir, setHintDir] = useState<Dir | null>(null);
  const [coach, setCoach] = useState<string | null>(null);

  const soundRef = useRef<SoundHandle | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const blockedTimerRef = useRef<number | null>(null);
  /** 本次会话里已经看过教学气泡的关卡 —— 不写进存档，重开关卡时不必再念一遍。 */
  const seenCoachRef = useRef<Set<string>>(new Set());
  /** 通关副作用只该跑一次（solved 会在重渲染里反复为 true）。 */
  const solvedKeyRef = useRef('');
  const bootedRef = useRef(false);

  const level = levels[session.levelIndex];
  const def = level?.def ?? null;
  const total = levels.length;
  const isLast = session.levelIndex === total - 1;

  const clearHint = useCallback(() => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = null;
    setHintDir(null);
  }, []);

  const showHintArrow = useCallback((dir: Dir) => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    setHintDir(dir);
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      setHintDir(null);
    }, HINT_VISIBLE_MS);
  }, []);

  // ── 进入某一关：重置会话、记下「正在玩哪一关」、决定要不要念教学气泡 ──────────
  const enterLevel = useCallback((index: number) => {
    const target = levels[index];
    if (!target) return;
    dispatch({ type: 'load', index });
    setShowLevels(false);
    setShowResult(false);
    clearHint();
    setProgress((prev) => rememberLevel(prev, target.id));
    const teaches = target.def.coach;
    if (teaches && !seenCoachRef.current.has(target.id)) {
      seenCoachRef.current.add(target.id);
      setCoach(teaches);
    } else {
      setCoach(null);
    }
  }, [clearHint, levels]);

  // 挂载：读存档 → 续上次的关 → 首次访问弹引导。
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const stored = loadProgress();
    setProgress(stored);
    setHydrated(true);
    soundRef.current = createSound(stored.muted);
    const index = resolveStartIndex(stored);
    dispatch({ type: 'load', index });
    if (!stored.seenIntro) setShowOnboard(true);
    const target = levels[index];
    if (target?.def.coach && !seenCoachRef.current.has(target.id)) {
      seenCoachRef.current.add(target.id);
      setCoach(target.def.coach);
    }
    // 只在挂载时跑一次；levels 是稳定引用。
  }, [levels]);

  // 存档：挂在 progress 变化上统一写，避免每个改档点各写一次（漏一处就丢一次进度）。
  useEffect(() => {
    if (!hydrated) return;
    saveProgress(progress);
  }, [progress, hydrated]);

  useEffect(() => {
    soundRef.current?.setMuted(progress.muted);
  }, [progress.muted]);

  // 音效：按「这一次发生了什么」分支，而不是去比状态差异。
  useEffect(() => {
    const sound = soundRef.current;
    if (!sound) return;
    switch (session.last) {
      case 'move': {
        const events = session.events;
        if (!events) break;
        const slid = Math.max(events.selves.a.slide, events.selves.b.slide);
        if (slid > 0) sound.slide(slid);
        if (events.pushes.length > 0) sound.push();
        else if (slid === 0) sound.move();
        break;
      }
      case 'blocked':
        sound.blocked();
        break;
      case 'undo':
        sound.undo();
        break;
      case 'load':
      case 'restart':
      case 'hint':
        sound.ui();
        break;
      default:
        break;
    }
  }, [session.serial, session.last, session.events]);

  // 闪红回收：动画演完就收回去，免得红色一直挂着。
  useEffect(() => {
    if (!session.blocked) return;
    if (blockedTimerRef.current !== null) window.clearTimeout(blockedTimerRef.current);
    blockedTimerRef.current = window.setTimeout(() => {
      blockedTimerRef.current = null;
      dispatch({ type: 'blocked-clear' });
    }, BLOCKED_FLASH_MS);
    return () => {
      if (blockedTimerRef.current !== null) {
        window.clearTimeout(blockedTimerRef.current);
        blockedTimerRef.current = null;
      }
    };
  }, [session.blocked, session.serial]);

  // 通关：记成绩 + 放音 + 稍后弹结算。
  useEffect(() => {
    if (!session.solved || !level) return;
    const key = `${level.id}:${session.serial}`;
    if (solvedKeyRef.current === key) return;
    solvedKeyRef.current = key;
    const moves = session.state.moves;
    setProgress((prev) => recordClear(prev, level.id, moves));
    soundRef.current?.solve(session.levelIndex === levels.length - 1);
    const timer = window.setTimeout(() => setShowResult(true), RESULT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [session.solved, session.serial, session.state.moves, session.levelIndex, level, levels.length]);

  // 定时器收摊：切关 / 关页面时别留下会 dispatch 的幽灵定时器。
  useEffect(() => () => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    if (blockedTimerRef.current !== null) window.clearTimeout(blockedTimerRef.current);
  }, []);

  const overlayOpen = showLevels || showOnboard || showResult;
  const interactive = hydrated && !overlayOpen && !session.solved && total > 0;

  const move = useCallback((dir: Dir) => {
    if (!hydrated || showLevels || showOnboard || showResult) return;
    clearHint();
    dispatch({ type: 'move', dir });
  }, [clearHint, hydrated, showLevels, showOnboard, showResult]);

  const undo = useCallback(() => {
    if (!hydrated || showResult) return;
    clearHint();
    dispatch({ type: 'undo' });
  }, [clearHint, hydrated, showResult]);

  const restart = useCallback(() => {
    if (!hydrated) return;
    clearHint();
    dispatch({ type: 'restart' });
    setShowResult(false);
  }, [clearHint, hydrated]);

  const hint = useCallback(() => {
    if (!hydrated || !level || !def || showResult) return;
    const dir = nextBestMove(level, session.state);
    dispatch({ type: 'hint', text: def.hint, dir });
    if (dir) showHintArrow(dir);
  }, [def, hydrated, level, session.state, showHintArrow, showResult]);

  const toggleSound = useCallback(() => {
    setProgress((prev) => applyMuted(prev, !prev.muted));
    soundRef.current?.ui();
  }, []);

  const dismissCoach = useCallback(() => setCoach(null), []);

  const finishOnboard = useCallback(() => {
    setShowOnboard(false);
    setProgress((prev) => (prev.seenIntro ? prev : { ...prev, seenIntro: true }));
    soundRef.current?.ui();
  }, []);

  const openLevels = useCallback(() => {
    if (!hydrated) return;
    soundRef.current?.ui();
    setShowLevels(true);
  }, [hydrated]);

  const chooseLevel = useCallback((id: string) => {
    const index = levels.findIndex((entry) => entry.id === id);
    if (index >= 0) enterLevel(index);
  }, [enterLevel, levels]);

  const nextLevel = useCallback(() => {
    if (isLast) {
      setShowResult(false);
      setShowLevels(true);
      return;
    }
    enterLevel(session.levelIndex + 1);
  }, [enterLevel, isLast, session.levelIndex]);

  // 键盘：方向键 / WASD 走、Z 撤销、R 重来、H 提示、Esc 关浮层。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      if (event.key === 'Escape') {
        if (showLevels) setShowLevels(false);
        if (showResult) setShowResult(false);
        if (showOnboard) finishOnboard();
        return;
      }
      if (showLevels || showResult) return;

      const dir = KEY_DIRS[event.key];
      if (dir) {
        event.preventDefault();
        move(dir);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'u') {
        event.preventDefault();
        undo();
      } else if (key === 'r') {
        event.preventDefault();
        restart();
      } else if (key === 'h') {
        event.preventDefault();
        hint();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finishOnboard, hint, move, restart, showLevels, showOnboard, showResult, undo]);

  // 触屏滑动：在棋盘上划一下就当作一次方向键（手机上比按方向键快得多）。
  const swipeRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    swipeRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }, []);
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const THRESHOLD = 24;
    if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
    if (Math.abs(dx) >= Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, [move]);

  if (total === 0 || !level || !def) {
    return (
      <div className="tw-page">
        <div className="tw-shell">
          <p className="tw-status" data-tone="warn">关卡数据出错了，暂时没法开始。请稍后再试。</p>
        </div>
      </div>
    );
  }

  const stars = starsFor(session.state.moves, def.par);

  return (
    <div className="tw-page">
      <div className="tw-shell">
        <Hud
          backHref={backHref}
          backLabel={backLabel}
          def={def}
          index={session.levelIndex + 1}
          total={total}
          moves={session.state.moves}
          par={def.par}
          stars={stars}
          soundOn={!progress.muted}
          canUndo={session.history.length > 0 && !session.solved}
          coach={coach}
          status={session.status}
          cleared={def.id in progress.best}
          onUndo={undo}
          onRestart={restart}
          onHint={hint}
          onToggleSound={toggleSound}
          onOpenLevels={openLevels}
          onDismissCoach={dismissCoach}
        />

        <div
          className="tw-board-card"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { swipeRef.current = null; }}
        >
          <div className="tw-board-wrap">
            <Board
              level={level}
              state={session.state}
              events={session.events}
              serial={session.serial}
              hintDir={hintDir}
              blocked={session.blocked}
              solved={session.solved}
            />
          </div>
        </div>

        <Dpad onMove={move} disabled={!interactive} />

        {/* 键位图例分两档：触屏设备上没有方向键可按，念一遍 WASD 只是噪音。
            用 hover/宽度两个条件切换，纯 CSS（见 _twinshade.scss 的 .tw-keys__*）。 */}
        <p className="tw-keys">
          <span className="tw-keys__desktop">方向键 / WASD 移动 · Z 撤销 · R 重来 · H 提示 · 也可以在棋盘上滑动</span>
          <span className="tw-keys__touch">在棋盘上滑动，或点下方的方向键</span>
        </p>
      </div>

      <LevelSelect
        open={showLevels}
        levels={LEVELS}
        currentId={def.id}
        best={progress.best}
        onSelect={chooseLevel}
        onClose={() => setShowLevels(false)}
      />

      <Result
        open={showResult}
        def={def}
        moves={session.state.moves}
        par={def.par}
        stars={stars}
        isLast={isLast}
        onNext={nextLevel}
        onReplay={restart}
        onLevels={() => { setShowResult(false); setShowLevels(true); }}
      />

      <Onboarding
        open={showOnboard}
        onStart={finishOnboard}
        onDismiss={finishOnboard}
      />
    </div>
  );
}
