'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, FlipHorizontal2, Fingerprint, FoldHorizontal, Lightbulb, RotateCcw, Undo2, Redo2 } from 'lucide-react';
import { attempt, goalStatus, initialState, isWon, multiply, reflectionMatrix, replay, type Action, type Face, type State } from './engine';
import { LEVELS, levelById } from './levels';
import { freshProgress, readProgress, SAVE_KEY, type Progress } from './progress';
import Paper, { Glyph } from './Paper';

const EMPTY: Action[] = [];
type View = { face: Face; fold: number; flip: number };
export default function Hinge3() {
  const [progress, setProgress] = useState<Progress>(freshProgress), [ready, setReady] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const [selection, setSelection] = useState('A'), [notice, setNotice] = useState(''), [hint, setHint] = useState(0), [rules, setRules] = useState(false);
  const [redos, setRedos] = useState<Record<string, Action[]>>({}), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false);
  const [view, setView] = useState<View>({ face: 'front', fold: 0, flip: 0 });
  const frame = useRef(0), locked = useRef(false), stage = useRef<HTMLElement>(null);
  const level = levelById(progress.selected), actions = progress.runs[level.id] ?? EMPTY;
  const state = useMemo(() => replay(level, actions) ?? initialState(level), [level, actions]);
  const crease = level.creases.find((item) => item.id === (state.fold?.crease ?? selection)) ?? level.creases[0];
  const won = isWon(level, state), future = redos[level.id] ?? EMPTY;
  const completed = LEVELS.filter((item) => isWon(item, replay(item, progress.runs[item.id] ?? EMPTY) ?? initialState(item)));
  const matched = level.goals.filter((goal) => goalStatus(goal, state) === 'matched').length;

  useEffect(() => {
    let saved = freshProgress();
    try { saved = readProgress(localStorage.getItem(SAVE_KEY)); } catch { setSaveFailed(true); }
    const nextLevel = levelById(saved.selected), next = replay(nextLevel, saved.runs[nextLevel.id] ?? EMPTY) ?? initialState(nextLevel);
    setProgress(saved); setSelection(next.fold?.crease ?? nextLevel.creases[0].id); setView({ face: next.face, fold: next.fold ? 1 : 0, flip: 0 }); setReady(true);
    return () => cancelAnimationFrame(frame.current);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch { setSaveFailed(true); }
  }, [progress, ready]);

  function animate(next: State) {
    const end = next.fold ? 1 : 0, from = view;
    const flip = from.face !== next.face;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || (!flip && Math.abs(from.fold - end) < .001)) { setView({ face: next.face, fold: end, flip: 0 }); return; }
    let start: number | undefined;
    locked.current = true; setBusy(true);
    function tick(time: number) {
      start ??= time;
      const t = Math.min(1, (time - start) / (flip ? 620 : 780)), eased = t * t * (3 - 2 * t);
      setView({ face: flip && t < .5 ? from.face : next.face, fold: from.fold + (end - from.fold) * eased, flip: flip ? eased * 180 - (t >= .5 ? 180 : 0) : 0 });
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else { locked.current = false; setBusy(false); setView({ face: next.face, fold: end, flip: 0 }); }
    }
    frame.current = requestAnimationFrame(tick);
  }
  function choose(id: string) {
    cancelAnimationFrame(frame.current); locked.current = false; setBusy(false); setDragging(false);
    const nextLevel = levelById(id), next = replay(nextLevel, progress.runs[id] ?? EMPTY) ?? initialState(nextLevel);
    setProgress((p) => ({ ...p, selected: id })); setSelection(next.fold?.crease ?? nextLevel.creases[0].id);
    setView({ face: next.face, fold: next.fold ? 1 : 0, flip: 0 }); setNotice(''); setHint(0);
  }
  function perform(action: Action) {
    if (!ready || locked.current) return;
    const result = attempt(level, state, action);
    if (result.state === state) { setNotice(result.error ?? ''); return; }
    if (action.type === 'fold') setSelection(action.crease);
    setNotice(action.type === 'press' ? result.printed ? `已留下 ${result.printed} 处新印痕，展开查看。` : '没有墨接触到完整纸面。展开后可以换一条折痕。' : '');
    animate(result.state);
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] } }));
    setRedos((r) => ({ ...r, [level.id]: [] }));
  }
  function undo() {
    if (!actions.length || locked.current || dragging) return;
    const run = actions.slice(0, -1), next = replay(level, run)!;
    if (next.fold) setSelection(next.fold.crease);
    animate(next); setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: run } }));
    setRedos((r) => ({ ...r, [level.id]: [...future, actions[actions.length - 1]] })); setNotice('');
  }
  function redo() {
    if (!future.length || locked.current || dragging) return;
    const action = future[future.length - 1], next = attempt(level, state, action).state;
    if (next.fold) setSelection(next.fold.crease);
    animate(next); setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] } }));
    setRedos((r) => ({ ...r, [level.id]: future.slice(0, -1) })); setNotice('');
  }
  function reset() {
    if (locked.current || dragging) return;
    setRedos((r) => ({ ...r, [level.id]: [...future, ...actions.slice().reverse()] }));
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [] } })); setView({ face: 'front', fold: 0, flip: 0 }); setHint(0); setNotice('已重置，可用重做恢复刚才的压印。');
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey || locked.current || dragging || !ready) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (key === 'f') { event.preventDefault(); perform({ type: 'flip' }); }
    else if (key === 'enter' && event.target === stage.current) { event.preventDefault(); perform(state.fold ? state.fold.pressed ? { type: 'unfold' } : { type: 'press' } : { type: 'fold', crease: crease.id }); }
    else if (!state.fold && ['a', 'b', 'c'].includes(key)) { const item = level.creases.find((c) => c.id.toLowerCase() === key); if (item) { event.preventDefault(); setSelection(item.id); } }
  }
  function foldDrag(value: number | null, commit?: 'fold' | 'unfold') {
    if (value !== null) { setDragging(true); setView((v) => ({ ...v, fold: value })); return; }
    setDragging(false);
    if (commit) perform(commit === 'fold' ? { type: 'fold', crease: crease.id } : { type: 'unfold' });
    else animate(state);
  }
  const disabled = !ready || busy || dragging;
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];
  const backMirror = reflectionMatrix({ id: 'view', name: '', nx: 1, ny: 0, c: 4, side: 1 });

  return <div className="container h3-game" data-ready={ready} onKeyDown={onKey}>
    <header className="h3-header"><div className="h3-brand"><Link className="h3-icon-button" href="/game/collections/test" aria-label="返回测试合集"><ArrowLeft size={19} /></Link><h1>合页 <span>III</span></h1><span className="h3-demo">Demo 3</span></div><span className="h3-progress">已完成 <span className="numeric">{completed.length} / {LEVELS.length}</span></span></header>
    <nav className="h3-levels" aria-label="选择纸页">{LEVELS.map((item, i) => <button key={item.id} className={`h3-tab${level.id === item.id ? ' is-active' : ''}`} aria-pressed={level.id === item.id} disabled={!ready} onClick={() => choose(item.id)}><span className="numeric">0{i + 1}</span>{item.title}{completed.includes(item) && <Check size={14} />}</button>)}</nav>
    <div className="h3-layout">
      <section className="h3-workspace" ref={stage} tabIndex={0} aria-label="合页第三版纸面工作台" data-level={level.id} data-face={state.face} data-fold={state.fold?.crease ?? ''} data-pressed={state.fold?.pressed ?? false} data-won={won} data-busy={busy} data-dragging={dragging}>
        <div className="h3-sheet-header"><div><span className="h3-eyebrow">纸面机关 <span className="numeric">0{LEVELS.indexOf(level) + 1}</span></span><h2>{level.title}</h2></div><button className="h3-secondary h3-face-button" onClick={() => perform({ type: 'flip' })} disabled={disabled || !!state.fold} aria-label={state.face === 'front' ? '翻到背面' : '翻到正面'}><FlipHorizontal2 size={17} /><span>{state.face === 'front' ? '正面' : '背面'}</span><span className="h3-key">F</span></button></div>
        <div className={`h3-paper-stage${state.fold?.pressed ? ' is-pressed' : ''}`}><div className="h3-paper-rotation" style={{ transform: `rotateY(${view.flip}deg)` }}><Paper level={level} state={state} face={view.face} crease={crease} progress={view.fold} busy={disabled && !dragging} onSelect={setSelection} onFold={() => perform(state.fold ? { type: 'unfold' } : { type: 'fold', crease: crease.id })} onPress={() => perform({ type: 'press' })} onDrag={foldDrag} /></div></div>
        <div className="h3-paper-caption"><span><i className="h3-legend-wet" />湿墨 · 可以转印</span><span><i className="h3-legend-dry" />干痕 · 保留原处</span><span><i className="h3-legend-target" />虚线 · 目标方向</span></div>
        <div className={`h3-feedback${won ? ' is-won' : ''}`} role="status" aria-live="polite">{won && !busy ? <><span><Check size={19} />印记已对准</span>{nextLevel ? <button className="h3-primary" onClick={() => choose(nextLevel.id)}>下一张纸<ArrowRight size={16} /></button> : <span>双面套印完成，可切换纸页重新尝试。</span>}</> : <span>{notice || (busy ? state.fold ? '纸面正在接触…' : '正在展开纸页…' : level.rule)}</span>}</div>
        <div className="h3-utilities"><div><button className="h3-icon-button" onClick={undo} aria-label="撤销" disabled={disabled || !actions.length}><Undo2 size={18} /></button><button className="h3-icon-button" onClick={redo} aria-label="重做" disabled={disabled || !future.length}><Redo2 size={18} /></button><button className="h3-secondary" onClick={reset} disabled={disabled || !actions.length}><RotateCcw size={16} />重置</button></div><button className="h3-secondary" onClick={() => setHint((h) => h >= level.hints.length ? 0 : h + 1)} aria-expanded={hint > 0}><Lightbulb size={17} />提示</button></div>
        {hint > 0 && <div className="h3-hint"><Lightbulb size={17} /><p>{level.hints[hint - 1]}</p><button className="h3-secondary" onClick={() => setHint(0)}>收起</button></div>}
      </section>
      <aside className="h3-sidebar">
        <section className="h3-proof"><div className="h3-panel-heading"><h2>目标校样</h2><span className="numeric">{matched} / {level.goals.length}</span></div><p>位置、颜色和方向都要相同。</p><div className="h3-proof-list">{level.goals.map((goal, i) => {
          const status = goalStatus(goal, state), mirrored = goal.face === 'back' ? multiply(backMirror, goal.matrix) : goal.matrix;
          return <button className={`h3-proof-item${status === 'matched' ? ' is-matched' : ''}`} key={i} onClick={() => { if (goal.face !== state.face) perform({ type: 'flip' }); }} disabled={disabled || !!state.fold} aria-label={`查看${goal.face === 'front' ? '正面' : '背面'}目标`}><svg viewBox="-1 -1 2 2" aria-hidden="true"><Glyph matrix={mirrored} color={goal.color} outline={status !== 'matched'} /></svg><span><strong>{goal.face === 'front' ? '正面 · 红印' : '背面 · 蓝印'}</strong><small>{status === 'matched' ? '已对准' : status === 'wrong' ? '印痕方向或颜色不符' : '等待转印'}</small></span>{status === 'matched' ? <Check size={18} /> : <span className="h3-proof-empty">○</span>}</button>;
        })}</div></section>
        <section className="h3-press-controls"><div className="h3-panel-heading"><h2>折痕</h2><span>{state.fold ? '接触面已合起' : '点选或拖动纸上圆钮'}</span></div><div className="h3-crease-options">{level.creases.map((item) => <button className={`h3-tab${crease.id === item.id ? ' is-active' : ''}`} key={item.id} onClick={() => setSelection(item.id)} disabled={disabled || !!state.fold} aria-pressed={crease.id === item.id} aria-label={`选择折痕 ${item.id}`}><svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4Z" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".4" /><path d={item.nx && item.ny ? 'M4 4 20 20' : item.nx ? 'M12 3v18' : 'M3 12h18'} stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" /></svg>{item.name}</button>)}</div>
          {!state.fold ? <button className="h3-primary h3-main-action" onClick={() => perform({ type: 'fold', crease: crease.id })} disabled={disabled}><FoldHorizontal size={19} />沿 {crease.id} 折起<ArrowRight size={17} /></button> : <><button className="h3-primary h3-main-action" onClick={() => perform({ type: 'press' })} disabled={disabled || state.fold.pressed}><Fingerprint size={20} />{state.fold.pressed ? '已压印' : '压印'}{state.fold.pressed && <Check size={17} />}</button><button className="h3-secondary h3-unfold" onClick={() => perform({ type: 'unfold' })} disabled={disabled}><FoldHorizontal size={18} />展开纸页</button></>}
          <p className="h3-contact-note">{state.fold ? state.fold.pressed ? '展开后，新的湿印还能继续转印。' : '内部相接的同一面会转印；外露的一面不会。' : '折叠让两处纸面接触。压一下，墨就会留下镜像。'}</p>
        </section>
        <button className="h3-secondary h3-rule-toggle" onClick={() => setRules(!rules)} aria-expanded={rules}>操作与规则<ChevronDown size={14} className={rules ? 'is-open' : ''} /></button>
        {rules && <div className="h3-rules"><p>拖动纸上圆钮，或选择折痕后点「折起」。纸页合上后，点「压印」或纸上的「压一下」，再展开查看。</p><p>湿墨接触到另一处纸面，会留下镜像印痕；原处变干，新印仍湿。洞没有接墨的纸，压空后源墨仍湿。错误印痕可以撤销。</p><p>正反面的墨彼此独立。键盘 A / B / C 选择折痕，F 翻面；聚焦工作台后 Enter 依次折起、压印、展开。Z 撤销，Shift + Z 重做。</p></div>}
        <p className={`h3-save-note${saveFailed ? ' is-error' : ''}`}>{saveFailed ? '浏览器暂时无法保存，当前页仍可完整游玩。' : '进度自动保存在当前浏览器'}</p>
      </aside>
    </div>
  </div>;
}
