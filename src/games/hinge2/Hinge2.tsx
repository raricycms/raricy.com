'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Columns2, Lightbulb, RotateCcw, RotateCw, Undo2, Redo2, MoveUpRight } from 'lucide-react';
import { attempt, graph, initialState, isWon, poseOf, position, replay, route, transform, type Action, type Point, type Pose, type State } from './engine';
import { LEVELS, levelById } from './levels';
import { freshProgress, readProgress, SAVE_KEY, type Progress } from './progress';
import Scene, { project } from './Scene';

const EMPTY: Action[] = [];
type View = { pose: Pose; pawn: Point };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixPoint = (a: Point, b: Point, t: number): Point => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z ?? 0, b.z ?? 0, t) });

export default function Hinge2() {
  const [progress, setProgress] = useState<Progress>(freshProgress);
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [redos, setRedos] = useState<Record<string, Action[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [hint, setHint] = useState(0);
  const [rules, setRules] = useState(false);
  const [destinations, setDestinations] = useState(false);
  const level = levelById(progress.selected);
  const actions = progress.runs[level.id] ?? EMPTY;
  const state = useMemo(() => replay(level, actions) ?? initialState(level), [level, actions]);
  const startNode = level.nodes.find((node) => node.id === state.player)!;
  const [view, setView] = useState<View>(() => ({ pose: poseOf(initialState(LEVELS[0])), pawn: position(LEVELS[0].nodes[0], initialState(LEVELS[0])) }));
  const frame = useRef(0);
  const locked = useRef(false);
  const stage = useRef<HTMLElement>(null);
  const won = isWon(level, state);
  const future = redos[level.id] ?? EMPTY;
  const seals = level.nodes.filter((node) => node.seal);
  const completed = LEVELS.filter((item) => isWon(item, replay(item, progress.runs[item.id] ?? EMPTY) ?? initialState(item)));
  const reachable = level.nodes.filter((node) => node.id !== state.player && route(level, state, node.id));

  function snap(nextLevel = level, nextState = state) {
    cancelAnimationFrame(frame.current); locked.current = false; setBusy(false);
    setView({ pose: poseOf(nextState), pawn: position(nextLevel.nodes.find((node) => node.id === nextState.player)!, nextState) });
  }
  useEffect(() => {
    let saved = freshProgress();
    try { saved = readProgress(localStorage.getItem(SAVE_KEY)); } catch { setSaveFailed(true); }
    setProgress(saved);
    const nextLevel = levelById(saved.selected), nextState = replay(nextLevel, saved.runs[nextLevel.id] ?? EMPTY) ?? initialState(nextLevel);
    setView({ pose: poseOf(nextState), pawn: position(nextLevel.nodes.find((node) => node.id === nextState.player)!, nextState) });
    setReady(true);
    return () => cancelAnimationFrame(frame.current);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch { setSaveFailed(true); }
  }, [progress, ready]);

  function animate(next: State, action?: Action) {
    const node = level.nodes.find((item) => item.id === next.player)!;
    const finalPose = poseOf(next), finalPawn = position(node, next);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setView({ pose: finalPose, pawn: finalPawn }); return; }
    const from = view;
    const walk = action?.type === 'walk' ? route(level, state, action.to)?.map((id) => position(level.nodes.find((item) => item.id === id)!, state)) : null;
    const distances = walk?.slice(1).map((p, i) => Math.hypot(p.x - walk[i].x, p.y - walk[i].y)) ?? [];
    const total = distances.reduce((a, b) => a + b, 0);
    const duration = walk ? Math.min(2100, Math.max(300, total * 180)) : 850;
    let start: number | undefined;
    locked.current = true; setBusy(true);
    function tick(time: number) {
      start ??= time;
      const t = Math.min(1, (time - start) / duration);
      const eased = t * t * (3 - 2 * t);
      const pose: Pose = { turn: lerp(from.pose.turn, finalPose.turn, eased), mirror: lerp(from.pose.mirror, finalPose.mirror, eased), fold: lerp(from.pose.fold, finalPose.fold, eased) };
      let pawn = action && action.type !== 'walk' ? transform(node, node.surface, pose) : mixPoint(from.pawn, finalPawn, eased);
      if (walk && total > .001) {
        let remaining = t * total;
        for (let i = 0; i < distances.length; i++) {
          if (remaining <= distances[i] && distances[i] > .001) { pawn = mixPoint(walk[i], walk[i + 1], remaining / distances[i]); break; }
          remaining -= distances[i];
        }
      }
      setView({ pose, pawn });
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else { setView({ pose: finalPose, pawn: finalPawn }); locked.current = false; setBusy(false); }
    }
    frame.current = requestAnimationFrame(tick);
  }
  function choose(id: string) {
    const nextLevel = levelById(id), nextState = replay(nextLevel, progress.runs[id] ?? EMPTY) ?? initialState(nextLevel);
    snap(nextLevel, nextState); setProgress((p) => ({ ...p, selected: id })); setHint(0); setNotice(''); setDestinations(false);
  }
  function perform(action: Action) {
    if (!ready || locked.current) return;
    const result = attempt(level, state, action);
    setNotice(result.error ?? '');
    if (result.state === state) return;
    animate(result.state, action);
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] } }));
    setRedos((r) => ({ ...r, [level.id]: [] })); setDestinations(false);
  }
  function undo() {
    if (!actions.length || locked.current) return;
    const next = actions.slice(0, -1);
    animate(replay(level, next)!);
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: next } }));
    setRedos((r) => ({ ...r, [level.id]: [...future, actions[actions.length - 1]] })); setNotice('');
  }
  function redo() {
    if (!future.length || locked.current) return;
    const action = future[future.length - 1];
    animate(attempt(level, state, action).state, action);
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [...actions, action] } }));
    setRedos((r) => ({ ...r, [level.id]: future.slice(0, -1) })); setNotice('');
  }
  function reset() {
    snap(level, initialState(level));
    setRedos((r) => ({ ...r, [level.id]: [...future, ...actions.slice().reverse()] }));
    setProgress((p) => ({ ...p, runs: { ...p.runs, [level.id]: [] } })); setNotice('已重置这一页，可用重做恢复。'); setHint(0);
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey || locked.current) return;
    const key = event.key.toLowerCase();
    if (['q', 'e', 'm', 'f', 'z'].includes(key)) {
      event.preventDefault();
      if (key === 'z') { if (event.shiftKey) redo(); else undo(); }
      else perform(key === 'q' || key === 'e' ? { type: 'turn', amount: key === 'e' ? 1 : -1 } : { type: key === 'm' ? 'mirror' : 'fold' });
    } else if (key.startsWith('arrow')) {
      event.preventDefault();
      const current = project(position(startNode, state));
      const [dx, dy] = key === 'arrowright' ? [1, 0] : key === 'arrowleft' ? [-1, 0] : key === 'arrowdown' ? [0, 1] : [0, -1];
      // Include zero-length joints, so a key press can cross between aligned sheets.
      const links = graph(level, state);
      const adjacent = new Set(links.get(state.player));
      for (const id of [...adjacent]) {
        const other = project(position(level.nodes.find((node) => node.id === id)!, state));
        if (Math.hypot(current.x - other.x, current.y - other.y) < 2) (links.get(id) ?? []).forEach((next) => adjacent.add(next));
      }
      const candidates = reachable.filter((node) => adjacent.has(node.id)).map((node) => {
        const q = project(position(node, state)), x = q.x - current.x, y = q.y - current.y, distance = Math.hypot(x, y);
        return { node, distance, dot: distance > 2 ? (x * dx + y * dy) / distance : -1 };
      }).filter((item) => item.dot > .35).sort((a, b) => b.dot - a.dot || a.distance - b.distance);
      if (candidates[0]) perform({ type: 'walk', to: candidates[0].node.id });
    }
  }
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];

  return <div className="container h2-game" data-ready={ready}>
    <header className="h2-header">
      <div className="h2-brand"><Link href="/game/collections/test" className="h2-icon-button" aria-label="返回测试合集"><ArrowLeft size={19} /></Link><h1>合页 <span>II</span></h1><span className="h2-demo">Demo 2</span></div>
      <div className="h2-header-end"><span className="h2-completion">已完成 <span className="numeric">{completed.length} / 4</span></span><Link className="h2-text-link" href="/game/hinge">初版<MoveUpRight size={13} /></Link></div>
    </header>
    <div className="h2-layout">
      <nav className="h2-chapters" aria-label="选择章节">
        {LEVELS.map((item, i) => <button key={item.id} className={`h2-chapter${item.id === level.id ? ' is-active' : ''}`} aria-pressed={item.id === level.id} onClick={() => choose(item.id)} disabled={!ready}>
          <span className="h2-chapter-number numeric">0{i + 1}</span><span className="h2-chapter-title">{item.title}<small>{item.subtitle}</small></span>{completed.includes(item) ? <Check size={15} /> : <ArrowRight size={15} />}
        </button>)}
        <p className="h2-chapter-note">四张纸页可自由尝试</p>
      </nav>
      <section className="h2-workspace" ref={stage} tabIndex={0} onKeyDown={onKey} aria-label="合页第二版纸景" data-level={level.id} data-player={state.player} data-turn={((state.turn % 4) + 4) % 4} data-mirror={state.mirror} data-folded={state.folded} data-won={won} data-busy={busy}>
        <div className="h2-scene-heading"><div><p>第 <span className="numeric">0{LEVELS.indexOf(level) + 1}</span> 页</p><h2>{level.title}</h2></div><div className="h2-seal-count" aria-label={`已拾取${state.seals.length}枚印记，共${seals.length}枚`}><span aria-hidden="true">◇</span><span className="numeric">{state.seals.length} / {seals.length}</span><span>印记</span></div></div>
        <Scene level={level} state={state} pose={view.pose} pawn={view.pawn} busy={!ready || busy} onWalk={(to) => perform({ type: 'walk', to })} onMechanism={(type) => perform(type === 'turn' ? { type, amount: 1 } : { type })} />
        <div className="h2-scene-caption"><span><i />点击路面圆点行走</span><span>菱形印记 → 拱门</span></div>
        <div className="h2-mechanisms" aria-label="纸页机关">
          {level.mechanics.includes('turn') && <div className="h2-control-pair"><button className="h2-secondary" onClick={() => perform({ type: 'turn', amount: -1 })} disabled={!ready || busy} aria-label="逆时针转动整页"><RotateCcw size={18} /><span>左转</span></button><span className="h2-turn-value numeric">{((state.turn % 4) + 4) % 4 * 90}°</span><button className="h2-secondary" onClick={() => perform({ type: 'turn', amount: 1 })} disabled={!ready || busy} aria-label="顺时针转动整页"><RotateCw size={18} /><span>右转</span></button></div>}
          {level.mechanics.includes('mirror') && <button className={`h2-primary${state.mirror ? ' is-active' : ''}`} onClick={() => perform({ type: 'mirror' })} disabled={!ready || busy} aria-label="转动镜面"><Columns2 size={18} />转动镜面<span className="h2-key">M</span></button>}
          {level.mechanics.includes('fold') && <button className="h2-primary" onClick={() => perform({ type: 'fold' })} disabled={!ready || busy} aria-label={state.folded ? '展开右半页' : '对折右半页'}><svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 9 4 9-6v16l-9 4-9-4Zm9 4v14" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{state.folded ? '展开右页' : '对折右页'}<span className="h2-key">F</span></button>}
        </div>
        <div className={`h2-feedback${won ? ' is-won' : ''}`} role="status" aria-live="polite">
          {won && !busy ? <><span><Check size={18} />这一页已完成</span>{nextLevel ? <button className="h2-primary" onClick={() => choose(nextLevel.id)}>下一页<ArrowRight size={16} /></button> : <span>四页机关已全部呈现，可切换章节重玩。</span>}</> : <span>{notice || (busy ? '纸景变化中…' : level.instruction)}</span>}
        </div>
        <div className="h2-utilities"><div><button className="h2-icon-button" onClick={undo} disabled={!ready || busy || !actions.length} aria-label="撤销" title="撤销 Z"><Undo2 size={18} /></button><button className="h2-icon-button" onClick={redo} disabled={!ready || busy || !future.length} aria-label="重做" title="重做 Shift+Z"><Redo2 size={18} /></button><button className="h2-secondary" onClick={reset} disabled={!ready || busy || !actions.length}><RotateCcw size={16} />重置</button></div><div><button className="h2-secondary" onClick={() => setDestinations(!destinations)} aria-expanded={destinations}><MoveUpRight size={16} />可达位置<ChevronDown size={13} /></button><button className="h2-secondary" onClick={() => setHint((h) => h >= level.hints.length ? 0 : h + 1)} aria-expanded={hint > 0}><Lightbulb size={17} />提示</button></div></div>
        {destinations && <div className="h2-destinations" aria-label="可达位置列表">{reachable.length ? reachable.map((node) => <button className="h2-secondary" key={node.id} onClick={() => perform({ type: 'walk', to: node.id })} disabled={busy}>{node.name}{node.surface === 'reflection' ? ' · 倒影' : node.surface === 'wing' ? ' · 右页' : ''}<ArrowRight size={14} /></button>) : <p>暂时没有相连的落点，请操作纸页机关。</p>}</div>}
        {hint > 0 && <div className="h2-hint"><Lightbulb size={18} /><p>{level.hints[hint - 1]}</p><button className="h2-secondary" onClick={() => setHint(0)}>收起</button></div>}
      </section>
    </div>
    <footer className="h2-footer"><button className="h2-secondary" onClick={() => setRules(!rules)} aria-expanded={rules}>操作与规则<ChevronDown size={14} className={rules ? 'is-open' : ''} /></button><span className={saveFailed ? 'h2-save-error' : ''}>{saveFailed ? '浏览器暂时无法保存，仍可完整游玩。' : '进度自动保存在当前浏览器'}</span></footer>
    {rules && <div className="h2-rules"><p>点击圆点即可沿相连道路走到那里；细线交叉处不能换路，只有圆点重合时才接通。白色的外侧平台固定，纸页、镜中道路和右半页会带着站在上面的人一起移动。</p><p>触屏可用「可达位置」选择落点。键盘：方向键走路，Q / E 转页，M 转镜，F 折纸，Z 撤销，Shift + Z 重做。所有操作都可撤销；重置后也可逐步重做。</p></div>}
  </div>;
}
