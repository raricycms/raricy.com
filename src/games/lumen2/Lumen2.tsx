'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Eraser, Grid2X2, Lightbulb, Redo2, RotateCcw, Undo2, X } from 'lucide-react';
import Board, { COLOR_NAMES } from './Board';
import { countMirrors, emptyBoard, trace, type Mirror } from './engine';
import { CHAPTERS, LEVELS } from './levels';
import { freshProgress, readProgress, STORAGE_KEY, type Progress } from './progress';
import { LumenIcon } from '../lumen/icons';

function Modal({ title, children, close, opener }: { title: string; children: ReactNode; close: () => void; opener: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close(); opener?.focus({ preventScroll: true }); }; }, [opener]);
  return <dialog ref={ref} className="l2-dialog" aria-label={title} onCancel={close} onClick={(e) => {
    if (e.target !== e.currentTarget) return;
    const b = e.currentTarget.getBoundingClientRect();
    if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) close();
  }}><div className="l2-dialog-heading"><h2>{title}</h2><button className="l2-icon" onClick={close} aria-label="关闭"><X size={20} /></button></div>{children}</dialog>;
}

export default function Lumen2() {
  const [progress, setProgress] = useState<Progress>(() => freshProgress(LEVELS));
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tool, setTool] = useState<Mirror>(1);
  const [past, setPast] = useState<Mirror[][]>([]);
  const [future, setFuture] = useState<Mirror[][]>([]);
  const [hints, setHints] = useState(0);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'levels' | 'help' | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = LEVELS.findIndex((l) => l.id === progress.current.id);
  const level = LEVELS[index];
  const board = progress.current.board;
  const result = useMemo(() => trace(level, board), [level, board]);
  const remaining = level.stock - result.used;

  useEffect(() => {
    try { setProgress(readProgress(localStorage.getItem(STORAGE_KEY), LEVELS)); } catch { setSaveFailed(true); }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); setSaveFailed(false); } catch { setSaveFailed(true); }
  }, [progress, ready]);

  function change(next: Mirror[]) {
    const solved = trace(level, next).solved;
    setProgress((p) => ({ ...p, current: { id: level.id, board: next }, completed: solved && !p.completed.includes(level.id) ? [...p.completed, level.id] : p.completed }));
    setNotice('');
  }
  function edit(next: Mirror[]) {
    if (next.every((v, i) => v === board[i])) return;
    setPast((p) => [...p.slice(-199), board]); setFuture([]); change(next);
  }
  function place(i: number, remove = false) {
    if (!ready) return;
    const value = remove || board[i] === tool ? 0 : tool;
    if (value && !board[i] && !remaining) { setNotice('镜片已用完。选「收回」，或再点一次同向镜片，腾出一面。'); return; }
    edit(board.map((v, n) => n === i ? value : v));
  }
  function undo() {
    if (!past.length) return;
    setFuture((p) => [board, ...p].slice(0, 200)); change(past[past.length - 1]); setPast((p) => p.slice(0, -1));
  }
  function redo() {
    if (!future.length) return;
    setPast((p) => [...p, board].slice(-200)); change(future[0]); setFuture((p) => p.slice(1));
  }
  function select(next: number) {
    if (!ready || !LEVELS[next]) return;
    const selected = LEVELS[next];
    setProgress((p) => ({ ...p, current: { id: selected.id, board: emptyBoard(selected) } }));
    setPast([]); setFuture([]); setHints(0); setNotice(''); setModal(null);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function open(kind: 'levels' | 'help', trigger: HTMLButtonElement) { opener.current = trigger; setModal(kind); }

  return <div className="container l2-game" onKeyDown={(e) => {
    if (modal || !ready || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    if (key === 'y') { e.preventDefault(); redo(); }
    if (key === 'r') { e.preventDefault(); edit(emptyBoard(level)); }
    if (['1', '2', '3'].includes(key)) { e.preventDefault(); setTool(key === '3' ? 0 : Number(key) as Mirror); }
  }}>
    <header className="l2-header"><div className="l2-brand"><Link href="/game/collections/test" className="l2-icon" aria-label="返回测试合集"><ArrowLeft size={20} /></Link><span className="l2-logo" aria-hidden="true"><LumenIcon /></span><h1>折光 <span>2</span></h1></div>
      <div className="l2-header-actions"><span className="l2-completion"><CheckCheck size={16} /><span className="numeric">{progress.completed.length} / {LEVELS.length}</span><span> 已解</span></span><button className="l2-icon" aria-label="玩法说明" onClick={(e) => open('help', e.currentTarget)}><CircleHelp size={21} /></button></div>
    </header>
    <div className="l2-layout">
      <section className="l2-workbench" aria-label="折光 2 工作台">
        <div className="l2-level-heading"><div><span className="l2-eyebrow">{CHAPTERS[level.chapter].title} <span className="numeric">· {level.id} / {LEVELS.length}</span></span><h2 ref={heading} tabIndex={-1}>{level.title}</h2></div>
          <div className="l2-navigation"><button className="l2-icon" aria-label="上一关" disabled={!ready || index === 0} onClick={() => select(index - 1)}><ChevronLeft size={19} /></button><button className="l2-secondary" disabled={!ready} onClick={(e) => open('levels', e.currentTarget)}><Grid2X2 size={16} /><span>选关</span></button><button className="l2-icon" aria-label="下一关" disabled={!ready || index === LEVELS.length - 1} onClick={() => select(index + 1)}><ChevronRight size={19} /></button></div>
        </div>
        <p className="l2-intro">{level.intro}</p>
        <Board level={level} board={board} result={result} tool={tool} ready={ready} place={place} />
        <div className="l2-tray"><div className="l2-tools" role="group" aria-label="镜片工具">
          <button className={`l2-tool${tool === 1 ? ' is-active' : ''}`} aria-label="放置 / 镜片" aria-pressed={tool === 1} onClick={() => setTool(1)}><span className="l2-tool-mirror">/</span><kbd>1</kbd></button>
          <button className={`l2-tool${tool === 2 ? ' is-active' : ''}`} aria-label={'放置 \\ 镜片'} aria-pressed={tool === 2} onClick={() => setTool(2)}><span className="l2-tool-mirror">\</span><kbd>2</kbd></button>
          <button className={`l2-tool${tool === 0 ? ' is-active' : ''}`} aria-label="收回镜片" aria-pressed={tool === 0} onClick={() => setTool(0)}><Eraser size={17} /><span>收回</span></button>
        </div><div className="l2-stock" aria-label={`剩余 ${remaining} 面，共 ${level.stock} 面镜片`}><span>剩余镜片</span><strong className="numeric" data-testid="lumen2-stock">{remaining}<small> / {level.stock}</small></strong></div>
          <div className="l2-toolbar"><button className="l2-secondary" aria-label="撤销" title="撤销（Z）" disabled={!ready || !past.length} onClick={undo}><Undo2 size={17} /><span>撤销</span><kbd>Z</kbd></button><button className="l2-secondary" aria-label="重做" title="重做（Y）" disabled={!ready || !future.length} onClick={redo}><Redo2 size={17} /><span>重做</span><kbd>Y</kbd></button><button className="l2-secondary" aria-label="清空" title="清空（R）" disabled={!ready || !countMirrors(board)} onClick={() => edit(emptyBoard(level))}><RotateCcw size={16} /><span>清空</span><kbd>R</kbd></button></div>
        </div>
        <p className="l2-placement-note">选镜片，再点安装点。再点同向镜片可收回。</p>
        <p className="l2-notice" role="status">{notice}</p>
      </section>
      <aside className="l2-sidebar">
        <section className="l2-task"><div className="l2-section-heading"><h3>同时接通同色出口</h3><span className="numeric">{result.lit.length} / {level.targets.length}</span></div>
          <ul className="l2-targets" aria-label="光路状态">{result.beams.map((b, i) => <li key={i} data-color={b.color} data-arrived={b.outcome === 'arrived'}><span className="l2-light-symbol" aria-hidden="true">{b.color === 'gold' ? '○' : '◇'}</span><span>{COLOR_NAMES[b.color]}</span><span>{b.outcome === 'arrived' ? <><Check size={15} />已送达</> : b.outcome === 'wrong' ? '进错圆环' : b.outcome === 'loop' ? '形成回环' : '尚未接通'}</span></li>)}</ul>
          <p className="l2-rule-note">空位让光直行，镜片让光转弯。两束光经过同一面镜片时，都按它的朝向反射。</p>
        </section>
        <div className="l2-feedback" aria-live="polite" aria-atomic="true">{result.solved ? <section className="l2-result"><span className="l2-result-mark"><CheckCheck size={24} /></span><h3>{progress.completed.length === LEVELS.length ? '十二道谜题，全部解开' : '两端都对上了'}</h3><p>{level.insight}</p>{index < LEVELS.length - 1 ? <button className="l2-primary" onClick={() => select(index + 1)}>下一道谜题<ArrowRight size={17} /></button> : <button className="l2-primary" onClick={(e) => open('levels', e.currentTarget)}>查看全部关卡<Grid2X2 size={17} /></button>}</section> : <section className="l2-hints"><div className="l2-section-heading"><h3><Lightbulb size={17} />推理线索</h3><span className="numeric">{hints} / {level.hints.length}</span></div>{hints === 0 ? <p>卡住时再展开。第一条只给思考方向，最后一条会指出关键位置。</p> : <ol>{level.hints.slice(0, hints).map((hint, i) => <li key={i}>{hint}</li>)}</ol>}<button className="l2-secondary" disabled={!ready || hints === level.hints.length} onClick={() => setHints((h) => h + 1)}>{hints === 0 ? '展开第一条' : hints === level.hints.length ? '线索已全部展开' : '再展开一条'}</button></section>}</div>
        <section className="l2-about"><h3>不计步数，只看解法</h3><p>可以自由选关、试验和撤销。镜片库存是谜题的约束，操作次数不是。</p><Link href="/game/lumen">回到初代折光<ArrowRight size={14} /></Link></section>
      </aside>
    </div>
    <p className="l2-save-note">{saveFailed ? '浏览器未允许存档，本次仍可正常游玩。' : '进度自动保存在当前浏览器。'}</p>
    {modal === 'levels' && <Modal title="十二道谜题" opener={opener.current} close={() => setModal(null)}><p className="l2-dialog-intro">所有关卡都可以直接尝试。切换关卡时会清空当前摆放。</p><div className="l2-chapters">{CHAPTERS.map((chapter, c) => <section key={c}><h3><span className="numeric">0{c + 1}</span>{chapter.title}</h3><p>{chapter.concept}</p><div className="l2-level-grid">{LEVELS.map((l, n) => l.chapter === c && <button className={`l2-level${l.id === level.id ? ' is-active' : ''}`} key={l.id} aria-label={`第 ${l.id} 关 ${l.title}${progress.completed.includes(l.id) ? '，已解' : ''}`} aria-current={l.id === level.id ? 'step' : undefined} onClick={() => select(n)}><span className="numeric">{l.id}</span><span>{l.title}</span>{progress.completed.includes(l.id) && <Check size={14} />}</button>)}</div></section>)}</div></Modal>}
    {modal === 'help' && <Modal title="折光 2 的规则" opener={opener.current} close={() => setModal(null)}><div className="l2-help"><p>把有限的镜片放进安装点，让每束光进入同色圆环。所有光源必须同时接通。</p><div className="l2-help-mirrors"><div><svg viewBox="0 0 100 70" aria-hidden="true"><path d="M8 53H50V8" fill="none" stroke="#e6af55" strokeWidth="2" /><path d="m32 65 36-36" stroke="currentColor" strokeWidth="4" /></svg><strong>/ 镜片</strong><span>向右 → 向上</span></div><div><svg viewBox="0 0 100 70" aria-hidden="true"><path d="M8 17H50V62" fill="none" stroke="#4c9fb8" strokeWidth="2" /><path d="m32 0 36 36" stroke="currentColor" strokeWidth="4" /></svg><strong>\ 镜片</strong><span>向右 → 向下</span></div></div><ul><li>只能在带坐标的圆形安装点放镜片。空位和普通格都让光直行。</li><li>镜片从两面都能反射，对金光和蓝光的作用相同；空处交叉的光互不干扰。</li><li>光源带箭头，出口带双圆环。金光用圆形标记，蓝光用菱形标记和虚线路径。</li><li>选择 /、\ 或收回，再点安装点。再点同向镜片也能收回。</li><li>不限制试验次数。已点亮的出口可以暂时熄灭，最后同时接通即可。</li></ul><p>键盘：1 / 2 选镜片，3 选收回；Tab 选安装点，空格摆放；Delete 收回；Z 撤销，Y 重做，R 清空。快捷键仅在游戏内聚焦时生效。</p></div><button className="l2-primary" onClick={() => setModal(null)}>开始推理<ArrowRight size={16} /></button></Modal>}
  </div>;
}
