'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Check, CornerUpLeft, CornerUpRight, RotateCcw, RotateCw, Undo2, Redo2, Lightbulb } from 'lucide-react';
import { attempt, DIRECTIONS, DIRECTION_NAMES, doors, initialState, isWon, KINDS, replay, roomAt, type Action, type Direction, type Room } from './engine';
import { LEVELS, MAIN_LEVEL, levelById } from './levels';
import { Arch, HingeIcon, MainPreview, Pawn, RoomDrawing } from './art';
import { freshProgress, readProgress, SAVE_KEY, type Progress } from './progress';

const Arrows = [ArrowUp, ArrowRight, ArrowDown, ArrowLeft];
const emptyActions: Action[] = [];

export default function Hinge() {
  const [progress, setProgress] = useState<Progress>(freshProgress);
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [selection, setSelection] = useState('bridge');
  const [redos, setRedos] = useState<Record<string, Action[]>>({});
  const [notice, setNotice] = useState('');
  const [hint, setHint] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; pointer: number } | null>(null);
  const stage = useRef<HTMLElement>(null);
  const level = levelById(progress.selected);
  const actions = progress.runs[level.id] ?? emptyActions;
  const state = useMemo(() => replay(level, actions) ?? initialState(level), [level, actions]);
  const selected = level.rooms.find((room) => room.id === selection) ?? level.rooms.find((room) => room.kind !== 'fixed')!;
  const current = level.rooms.find((room) => room.id === state.player.room)!;
  const won = isWon(level, state);
  const future = redos[level.id] ?? emptyActions;
  const completeCount = progress.completed.filter((id) => id !== 'main').length;

  useEffect(() => {
    try { setProgress(readProgress(localStorage.getItem(SAVE_KEY))); } catch { setSaveFailed(true); }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (Object.values(progress.runs).some((run) => run.length > 3000)) { setSaveFailed(true); return; }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch { setSaveFailed(true); }
  }, [progress, ready]);

  function choose(id: string) {
    const next = levelById(id);
    setProgress((p) => ({ ...p, selected: next.id }));
    setSelection(next.rooms.find((r) => r.kind !== 'fixed')!.id);
    setNotice(''); setHint(0); setDragging(null); drag.current = null;
  }
  function perform(action: Action) {
    if (!ready) return;
    const result = attempt(level, state, action);
    if (result.error) { setNotice(result.error); return; }
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] },
      completed: isWon(level, result.state) && !p.completed.includes(level.id) ? [...p.completed, level.id] : p.completed }));
    setRedos((r) => ({ ...r, [level.id]: [] })); setNotice('');
  }
  function undo() {
    if (!actions.length) return;
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: actions.slice(0, -1) } }));
    setRedos((r) => ({ ...r, [level.id]: [...future, actions[actions.length - 1]] })); setNotice('');
  }
  function redo() {
    if (!future.length) return;
    const action = future[future.length - 1];
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] } }));
    setRedos((r) => ({ ...r, [level.id]: future.slice(0, -1) })); setNotice('');
  }
  function reset() {
    // 重置也可以用「重做」逐步恢复，完成记录不会被抹掉。
    setRedos((r) => ({ ...r, [level.id]: [...future, ...actions.slice().reverse()] }));
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [] } })); setNotice('已回到本题开局。可用重做恢复刚才的操作。');
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey || !ready) return;
    const key = event.key.toLowerCase();
    const direction = ['arrowup', 'arrowright', 'arrowdown', 'arrowleft'].indexOf(key);
    const wasd = ['w', 'd', 's', 'a'].indexOf(key);
    if (direction >= 0 || wasd >= 0) {
      event.preventDefault();
      const d = (direction >= 0 ? direction : wasd) as Direction;
      perform(event.shiftKey ? { type: 'slide', room: selected.id, direction: d } : { type: 'walk', direction: d });
    } else if (key === 'q' || key === 'e') {
      event.preventDefault(); perform({ type: 'rotate', room: selected.id, amount: key === 'q' ? -1 : 1 });
    } else if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, room: Room) {
    if (event.button !== 0 || !ready) return;
    setSelection(room.id);
    if (room.kind !== 'slide') return;
    drag.current = { id: room.id, x: event.clientX, y: event.clientY, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    drag.current = null; setDragging(null);
    if (!start || start.pointer !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
    const direction: Direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 1 : 3 : dy > 0 ? 2 : 0;
    perform({ type: 'slide', room: start.id, direction });
  }
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];
  const boardStyle = { '--hy-columns': level.columns, '--hy-rows': level.rows, aspectRatio: `${level.columns} / ${level.rows}` } as CSSProperties;
  const connections = level.rooms.flatMap((room) => {
    const pose = state.poses[room.id];
    const exits = room.chambers.flatMap((_, chamber) => doors(room, pose, chamber));
    return ([1, 2] as const).flatMap((direction) => {
      if (!exits.includes(direction)) return [];
      const neighbor = roomAt(level, state, pose.x + (direction === 1 ? 1 : 0), pose.y + (direction === 2 ? 1 : 0));
      if (!neighbor || !neighbor.chambers.some((_, chamber) => doors(neighbor, state.poses[neighbor.id], chamber).includes(direction === 1 ? 3 : 0))) return [];
      return [{ key: `${room.id}-${neighbor.id}`, x: (pose.x + (direction === 1 ? 1 : .5)) * 100, y: (pose.y + (direction === 2 ? 1 : .5)) * 100, direction }];
    });
  });

  return <div className="container hy-game" data-ready={ready}>
    <header className="hy-header">
      <div className="hy-title"><Link className="hy-icon-button" href="/game/collections/test" aria-label="返回测试合集"><ArrowLeft size={20} /></Link><span className="hy-logo"><HingeIcon /></span><h1>合页 <small>Demo</small></h1></div>
      <span className="hy-progress">练习 <span className="numeric">{completeCount} / 5</span>{progress.completed.includes('main') && ' · 主谜题已完成'}</span>
    </header>

    <nav className="hy-levels" aria-label="选择纸页">
      {LEVELS.slice(0, 5).map((item) => <button key={item.id} className={`hy-tab${level.id === item.id ? ' is-active' : ''}`} aria-pressed={level.id === item.id} onClick={() => choose(item.id)} disabled={!ready}>
        <span className="numeric">{item.id}</span> {item.title}{progress.completed.includes(item.id) && <Check size={14} aria-label="已完成" />}
      </button>)}
      <button className={`hy-tab${level.id === 'main' ? ' is-active' : ''}`} aria-pressed={level.id === 'main'} onClick={() => choose('main')} disabled={!ready}>主谜题<ArrowRight size={15} /></button>
    </nav>

    <div className="hy-layout">
      <section className="hy-workspace" ref={stage} tabIndex={0} onKeyDown={onKey} aria-label="合页工作台" data-level={level.id} data-won={won} data-player={`${state.player.room}:${state.player.chamber}`}>
        <div className="hy-stage-heading"><div><p className="hy-eyebrow">{level.id === 'main' ? '主谜题 · 随时可试' : `练习 ${level.id}`}</p><h2>{level.title}</h2></div><div className="hy-goal-label"><svg viewBox="0 0 32 32" aria-hidden="true"><Arch x={16} y={15} /></svg><span>走到拱门标记</span></div></div>
        <div className="hy-board-wrap">
          <div className="hy-board" style={boardStyle} role="group" aria-label="房间与槽位">
            {level.slots.map(([x, y]) => <div className="hy-slot" key={`${x},${y}`} style={{ left: `${x / level.columns * 100}%`, top: `${y / level.rows * 100}%` }}><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M7 27V7h20M73 7h20v20M93 73v20H73M27 93H7V73M43 50h14M50 43v14" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg></div>)}
            <svg className="hy-connections" viewBox={`0 0 ${level.columns * 100} ${level.rows * 100}`} aria-hidden="true">{connections.map(({ key, x, y, direction }) => <g key={key} transform={`translate(${x} ${y}) rotate(${direction === 1 ? 0 : 90})`}><path d="M-16-11H16V11H-16Z" fill="#e9d8b5" /><path d="M-16-11H16M-16 11H16" stroke="#bda987" strokeWidth="1.5" /></g>)}</svg>
            {level.rooms.map((room) => {
              const pose = state.poses[room.id];
              const hasPlayer = state.player.room === room.id;
              return <button key={room.id} className={`hy-room${dragging === room.id ? ' hy-room--dragging' : ''}`} data-room={room.id} data-x={pose.x} data-y={pose.y} data-turn={pose.turn} data-kind={room.kind}
                style={{ left: `${pose.x / level.columns * 100}%`, top: `${pose.y / level.rows * 100}%` }}
                aria-label={`选择${room.name}，${KINDS[room.kind]}，第${pose.y + 1}行第${pose.x + 1}列${hasPlayer ? '，人物在此' : ''}${level.goal.room === room.id ? '，终点在此' : ''}`} aria-pressed={selected.id === room.id} disabled={!ready}
                onClick={() => setSelection(room.id)} onPointerDown={(e) => pointerDown(e, room)} onPointerUp={pointerUp}
                onPointerMove={(e) => { if (drag.current && drag.current.id === room.id && Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) > 12) setDragging(room.id); }}
                onPointerCancel={() => { drag.current = null; setDragging(null); }}>
                <RoomDrawing room={room} state={state} level={level} selected={selected.id === room.id} />
              </button>;
            })}
          </div>
        </div>
        <div className="hy-toolbar"><button className="hy-secondary" onClick={undo} disabled={!ready || !actions.length}><Undo2 size={17} />撤销</button><button className="hy-secondary" onClick={redo} disabled={!ready || !future.length}><Redo2 size={17} />重做</button><button className="hy-secondary" onClick={reset} disabled={!ready || !actions.length}><RotateCcw size={17} />重置本题</button><button className="hy-secondary hy-hint-button" onClick={() => setHint((h) => Math.min(h + 1, level.hints.length))} disabled={hint >= level.hints.length}><Lightbulb size={17} />{hint ? '再提示一点' : '一点提示'}</button></div>
        <div className={`hy-feedback${won ? ' hy-feedback--won' : ''}`} role="status" aria-live="polite">
          {won ? <><div><strong><Check size={18} />{level.id === 'main' ? '主谜题已完成' : '纸页已完成'}</strong><p>{level.insight}</p></div>{nextLevel && <button className="hy-primary" onClick={() => choose(nextLevel.id)}>{nextLevel.id === 'main' ? '尝试主谜题' : '下一张'}<ArrowRight size={16} /></button>}</>
            : <span>{notice || '点选纸片后可操作；红色棋子用方向键或下方走路按钮移动。'}</span>}
        </div>
        {hint > 0 && <div className="hy-hints"><span>提示 <span className="numeric">{hint} / {level.hints.length}</span></span><p>{level.hints[hint - 1]}</p><button className="hy-secondary" onClick={() => setHint(0)}>收起提示</button></div>}

        <div className="hy-controls">
          <div className="hy-control-group"><h3><svg viewBox="0 0 32 32" aria-hidden="true"><Pawn x={16} y={17} /></svg>人物走路</h3><p>{current.name}{current.chambers.length > 1 ? ` · ${state.player.chamber === 0 ? '条纹' : '点纹'}地毯半间` : ''}</p>
            <div className="hy-dpad" aria-label="人物移动">{DIRECTIONS.map((d) => { const Icon = Arrows[d]; return <button key={d} className={`hy-direction hy-direction--${d}`} aria-label={`向${DIRECTION_NAMES[d]}走`} onClick={() => perform({ type: 'walk', direction: d })} disabled={!ready}><Icon size={19} /></button>; })}<span className="hy-dpad-center" aria-hidden="true">走</span></div>
            <p className="hy-control-note">门朝{doors(current, state.poses[current.id], state.player.chamber).map((d) => DIRECTION_NAMES[d]).join('、')} · 方向键 / WASD</p>
          </div>
          <div className="hy-control-group"><h3>{selected.name}</h3><p>{KINDS[selected.kind]} · {selected.kind === 'slide' ? '沿导轨平移' : selected.kind === 'pivot' ? '绕中央转轴旋转' : '两枚固定钉'}</p>
            {selected.kind === 'slide' ? <div className="hy-dpad" aria-label="纸片移动">{DIRECTIONS.map((d) => { const Icon = Arrows[d]; const action: Action = { type: 'slide', room: selected.id, direction: d }; return <button key={d} className={`hy-direction hy-direction--${d}`} aria-label={`纸片向${DIRECTION_NAMES[d]}滑动`} onClick={() => perform(action)} disabled={!ready || !!attempt(level, state, action).error}><Icon size={19} /></button>; })}<span className="hy-dpad-center" aria-hidden="true">移</span></div>
              : selected.kind === 'pivot' ? <div className="hy-rotations"><button className="hy-primary" onClick={() => perform({ type: 'rotate', room: selected.id, amount: -1 })} aria-label="逆时针旋转纸片" disabled={!ready}><RotateCcw size={23} />左转</button><button className="hy-primary" onClick={() => perform({ type: 'rotate', room: selected.id, amount: 1 })} aria-label="顺时针旋转纸片" disabled={!ready}><RotateCw size={23} />右转</button></div>
                : <div className="hy-fixed-note">选一张带导轨或转轴的纸片。</div>}
            <p className="hy-control-note">{selected.kind === 'slide' ? '拖动一格 / Shift + 方向键' : selected.kind === 'pivot' ? 'Q 左转 / E 右转' : '点棋盘上的纸片切换选择'}</p>
          </div>
        </div>
      </section>
      <aside className="hy-sidebar">
        <button className={`hy-main-card${level.id === 'main' ? ' is-active' : ''}`} aria-label="主谜题：回到另一边" aria-pressed={level.id === 'main'} onClick={() => { choose('main'); stage.current?.focus({ preventScroll: true }); }} disabled={!ready}>
          <span className="hy-eyebrow">主谜题</span><strong>回到另一边{progress.completed.includes('main') && <Check size={17} />}</strong><MainPreview level={MAIN_LEVEL} state={initialState(MAIN_LEVEL)} /><span>从开局就能尝试<ArrowRight size={17} /></span>
        </button>
        <section className="hy-instructions"><h2>桌面的规则</h2><ul><li><CornerUpRight size={18} /><span><strong>导轨</strong>滑入相邻空槽，不能转向。</span></li><li><RotateCw size={18} /><span><strong>中央转轴</strong>原地转动，不能平移。</span></li><li><CornerUpLeft size={18} /><span><strong>两枚固定钉</strong>房间固定在底板上。</span></li></ul><p>门洞相接才能走过去。空槽没有地板，房内的墙不能穿过。</p><p>所有纸页都可自由切换。撤销快捷键 Z，重做 Shift + Z。</p><p className={saveFailed ? 'hy-save-note' : 'hy-local-note'}>{saveFailed ? '暂时无法保存进度；当前页面仍可完整试玩。' : '进度保存在此浏览器，可随时续玩。'}</p></section>
      </aside>
    </div>
  </div>;
}
