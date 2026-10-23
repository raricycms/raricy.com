'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleHelp, Grid2X2, Lightbulb, RotateCcw, Sparkles, Star, Undo2, Volume2, VolumeX, X } from 'lucide-react';
import { Board, LIGHT_NAMES, PieceArt } from './Board';
import { CHAPTERS, LEVELS } from './levels';
import { initialRotations, isRotatable, nextHint, starsFor, trace, type Piece } from './engine';
import { freshProgress, readProgress, STORAGE_KEY, type Progress } from './progress';
import { LumenIcon } from './icons';

function Stars({ count }: { count: number }) {
  return <span className="lm-stars" aria-label={`${count} 星`}>{[1, 2, 3].map((n) => <Star key={n} className={n <= count ? 'is-earned' : ''} size={16} aria-hidden="true" />)}</span>;
}

function Modal({ title, children, close, opener }: { title: string; children: ReactNode; close: () => void; opener: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); opener?.focus({ preventScroll: true }); };
  }, [opener]);
  return <dialog ref={ref} className="lm-dialog" aria-label={title} onCancel={close} onClick={(event) => {
    if (event.target === event.currentTarget) {
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }
  }}>
    <div className="lm-dialog-heading"><h2>{title}</h2><button className="lm-icon-button" onClick={close} aria-label="关闭"><X /></button></div>
    {children}
  </dialog>;
}

const RULES: { piece: Piece; title: string; text: string; chapter: number }[] = [
  { piece: { x: 0, y: 0, kind: 'mirror' }, title: '点一下，转一次', text: '镜片把光转过直角。点击或聚焦后按空格，切换 / 与 \\。带圆钉的镜片不能转。', chapter: 0 },
  { piece: { x: 0, y: 0, kind: 'receiver', color: 1 }, title: '全部同时点亮', text: '光源带箭头，接收器带外环。把正确的光送入每个接收器，圆环内会亮起，下面出现勾号。', chapter: 0 },
  { piece: { x: 0, y: 0, kind: 'splitter' }, title: '一束直行，一束转弯', text: '虚线镜片会分光：光的一部分沿原方向走，另一部分像普通镜片那样反射。', chapter: 1 },
  { piece: { x: 0, y: 0, kind: 'receiver', color: 3 }, title: '两种光，恰好相逢', text: '圆形认金光，菱形认蓝光，双环必须同时收到两种光。单色环混入另一色也不算点亮。光在空格交叉时互不干扰。', chapter: 2 },
  { piece: { x: 0, y: 0, kind: 'portal', pair: '1' }, title: '换位置，不换方向', text: '进入传送门，光从相同编号的另一扇门出来。向上进就向上出，两种颜色都可以通过。', chapter: 3 },
];

export default function Lumen() {
  const [progress, setProgress] = useState<Progress>(() => freshProgress(LEVELS));
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [history, setHistory] = useState<Progress['current'][]>([]);
  const [modal, setModal] = useState<'levels' | 'help' | null>(null);
  const modalTrigger = useRef<HTMLButtonElement | null>(null);
  const [hintStage, setHintStage] = useState(0);
  const [hintIndex, setHintIndex] = useState<number | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const levelHeading = useRef<HTMLHeadingElement>(null);
  const level = LEVELS.find((l) => l.id === progress.current.id)!;
  const index = LEVELS.indexOf(level);
  const { rotations, moves } = progress.current;
  const result = useMemo(() => trace(level, rotations), [level, rotations]);
  const totalStars = LEVELS.reduce((n, l) => n + (progress.best[l.id] === undefined ? 0 : starsFor(progress.best[l.id], l.par)), 0);
  const complete = Object.keys(progress.best).length;

  useEffect(() => {
    try { setProgress(readProgress(localStorage.getItem(STORAGE_KEY), LEVELS)); }
    catch { setSaveFailed(true); }
    setReady(true);
    return () => { void audio.current?.close().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }, [progress, ready]);
  useEffect(() => {
    if (!ready || !result.solved) return;
    resultHeading.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 767px)').matches) resultHeading.current?.parentElement?.scrollIntoView({ block: 'nearest' });
  }, [ready, result.solved]);

  const tone = useCallback((win = false) => {
    if (!progress.sound) return;
    try {
      const context = audio.current ?? new AudioContext();
      audio.current = context;
      void context.resume().catch(() => {});
      (win ? [523.25, 659.25, 783.99] : [440]).forEach((frequency, i) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + i * .09;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(.045, start + .015);
        gain.gain.exponentialRampToValueAtTime(.001, start + .24);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + .25);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      });
    } catch { /* Audio is optional, including in embedded browsers. */ }
  }, [progress.sound]);

  function rotate(piece: number) {
    if (!ready || result.solved || !isRotatable(level.pieces[piece])) return;
    const next = rotations.map((r, i) => i === piece ? 1 - r : r);
    const solved = trace(level, next).solved;
    setHistory((h) => [...h.slice(-199), progress.current]);
    setProgress((p) => ({ ...p, current: { id: level.id, rotations: next, moves: moves + 1 },
      best: solved ? { ...p.best, [level.id]: Math.min(p.best[level.id] ?? Infinity, moves + 1) } : p.best }));
    setHintIndex(null); setHintStage(0); tone(solved);
  }
  function undo() {
    if (!history.length) return;
    setProgress((p) => ({ ...p, current: history[history.length - 1] }));
    setHistory((h) => h.slice(0, -1)); setHintIndex(null); setHintStage(0);
  }
  function selectLevel(next: number) {
    const selected = LEVELS[next];
    if (!selected) return;
    setProgress((p) => ({ ...p, current: { id: selected.id, rotations: initialRotations(selected), moves: 0 } }));
    setHistory([]); setHintIndex(null); setHintStage(0); setModal(null);
    requestAnimationFrame(() => {
      levelHeading.current?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 767px)').matches) levelHeading.current?.scrollIntoView({ block: 'start' });
    });
  }
  function revealHint() {
    if (hintStage === 0) setHintStage(1);
    else { setHintIndex(nextHint(level, rotations)); setHintStage(2); }
  }
  function openModal(kind: 'levels' | 'help', trigger: HTMLButtonElement) {
    modalTrigger.current = trigger;
    setModal(kind);
  }

  return <div className="container lm-game" onKeyDown={(event) => {
    if (modal || !ready || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); selectLevel(index); }
  }}>
    <header className="lm-header">
      <div className="lm-heading"><Link href="/game/collections/test" className="lm-icon-button" aria-label="返回测试合集"><ArrowLeft /></Link><span className="lm-logo"><LumenIcon /></span><div><h1>折光</h1><p>转动镜片，点亮每一个终点。</p></div></div>
      <div className="lm-header-actions"><span className="lm-overall"><Sparkles size={16} /><span className="numeric">{totalStars} / {LEVELS.length * 3}</span></span>
        <button className="lm-icon-button" aria-label={progress.sound ? '关闭音效' : '开启音效'} aria-pressed={progress.sound} disabled={!ready} onClick={() => setProgress((p) => ({ ...p, sound: !p.sound }))}>{progress.sound ? <Volume2 /> : <VolumeX />}</button>
        <button className="lm-icon-button" aria-label="玩法说明" onClick={(event) => openModal('help', event.currentTarget)}><CircleHelp /></button>
      </div>
    </header>

    <div className="lm-layout">
      <section className="lm-workbench" aria-label="光学工作台">
        <div className="lm-bench-heading"><div><span className="lm-eyebrow">实验 <span className="numeric">{level.id} / {LEVELS.length}</span></span><h2 ref={levelHeading} tabIndex={-1}>{level.title}</h2></div>
          <button className="lm-secondary" onClick={(event) => openModal('levels', event.currentTarget)} disabled={!ready}><Grid2X2 size={17} />关卡</button>
        </div>
        <p className="lm-mobile-briefing">{level.briefing}</p>
        <div className="lm-board-wrap"><Board level={level} rotations={rotations} result={result} hint={hintIndex ?? (index === 0 && moves === 0 ? level.pieces.findIndex(isRotatable) : null)} rotate={rotate} ready={ready} /></div>
        <div className="lm-bench-footer"><span><span className="lm-light-dot" />光路实时更新</span><span>点击镜片旋转 <span aria-hidden="true">↻</span></span></div>
        <div className="lm-toolbar">
          <button className="lm-secondary" onClick={undo} disabled={!ready || !history.length}><Undo2 size={18} />撤销<kbd>Z</kbd></button>
          <button className="lm-secondary" onClick={() => selectLevel(index)} disabled={!ready}><RotateCcw size={17} />重来<kbd>R</kbd></button>
          <button className="lm-primary" onClick={revealHint} disabled={!ready || result.solved}><Lightbulb size={17} />{hintStage === 0 ? '给点提示' : '指出下一步'}</button>
        </div>
      </section>

      <aside className="lm-sidebar">
        <section className="lm-task">
          <div className="lm-chapter"><span className="numeric">{CHAPTERS[level.chapter].symbol}</span><div><span>当前章节</span><h3>{CHAPTERS[level.chapter].title}</h3></div></div>
          <p className="lm-briefing">{level.briefing}</p>
          <div className="lm-stats"><div><span>已点亮</span><strong><span className="numeric">{result.lit}</span><small className="numeric"> / {result.total}</small></strong></div><div><span>转动次数</span><strong className="numeric" data-testid="lumen-moves">{moves}</strong></div><div><span>三星目标</span><strong><span className="numeric">{level.par}</span><small> 次</small></strong></div></div>
          <ul className="lm-targets" aria-label="接收器状态">{level.pieces.map((p, i) => p.kind === 'receiver' && <li key={i} className={result.received[i] === p.color ? 'is-lit' : ''}>
            <span className="lm-target-symbol" data-color={p.color} aria-hidden="true">{p.color === 1 ? '○' : p.color === 2 ? '◇' : '○◇'}</span>
            <span>{LIGHT_NAMES[p.color!]} <span className="numeric">{String.fromCharCode(65 + p.x)}{p.y + 1}</span></span>
            <span>{result.received[i] === p.color ? <Check size={16} aria-label="已点亮" /> : result.received[i] ? (p.color === 3 ? '还缺一种光' : '颜色不对') : '等待光线'}</span>
          </li>)}</ul>
        </section>

        <div className="lm-feedback" aria-live="polite" aria-atomic="true">
          {result.solved ? <section className="lm-result" data-stars={starsFor(moves, level.par)}>
            <Stars count={starsFor(moves, level.par)} /><h3 ref={resultHeading} tabIndex={-1}>{complete === LEVELS.length ? '全部实验完成！' : '光路接通！'}</h3>
            <p>{moves <= level.par ? '每一次转动都恰到好处。' : `用了 ${moves} 次转动，再试试 ${level.par} 次的解法。`}</p>
            {index < LEVELS.length - 1 ? <button className="lm-primary" onClick={() => selectLevel(index + 1)}>{LEVELS[index + 1].chapter !== level.chapter ? '进入下一章' : '下一关'}<ArrowRight size={17} /></button> : <button className="lm-primary" onClick={(event) => openModal('levels', event.currentTarget)}>{complete === LEVELS.length ? '回看星图' : '挑战其他关卡'}<Grid2X2 size={17} /></button>}
            {complete === LEVELS.length && <p>已收集 <span className="numeric">{totalStars} / {LEVELS.length * 3}</span> 颗星。可重玩任意关卡，挑战更少的转动。</p>}
          </section> : hintStage ? <section className="lm-hint"><span className="lm-eyebrow"><Lightbulb size={15} />{hintStage === 1 ? '先想一想' : '下一步'}</span><p>{hintStage === 1 ? level.hint : hintIndex !== null ? `试着转动 ${String.fromCharCode(65 + level.pieces[hintIndex].x)}${level.pieces[hintIndex].y + 1}，棋盘上已经标出了它。` : '这条光路已经接通。'}</p><button className="lm-secondary" onClick={() => { setHintStage(0); setHintIndex(null); }}>收起提示</button></section>
            : <section className="lm-note"><Lightbulb size={18} /><p>{level.chapter === 0 ? '先沿着光走一遍，再从终点倒着想。所有操作都能撤销。' : level.chapter === 1 ? '分光镜会同时影响两条路。先接主路，再检查每个分支。' : level.chapter === 2 ? '颜色之外也有形状：圆形是金光，菱形是蓝光，双环需要两种光。' : level.chapter === 3 ? '穿门前后方向不变。找不到光时，去另一扇同号门看看。' : '把长光路拆成几个转角，先处理确定的部分。单色接收器可以帮你排除多余的光。'}</p></section>}
        </div>

        <section className="lm-journey"><div><h3>实验进度</h3><span className="numeric">{complete} / {LEVELS.length}</span></div>
          <div className="lm-progress-track" role="progressbar" aria-label="已完成关卡" aria-valuemin={0} aria-valuemax={LEVELS.length} aria-valuenow={complete}><span style={{ width: `${complete / LEVELS.length * 100}%` }} /></div>
          <button className="lm-secondary" onClick={(event) => openModal('levels', event.currentTarget)} disabled={!ready}>查看全部关卡<ArrowRight size={15} /></button>
        </section>
      </aside>
    </div>
    <p className="lm-save-note">{!ready ? '正在读取进度…' : saveFailed ? '浏览器未允许存档，本次仍可正常游玩。' : '进度自动保存在当前浏览器。没有计时，放心试。'}</p>

    {modal === 'levels' && <Modal title="实验星图" opener={modalTrigger.current} close={() => setModal(null)}><p className="lm-dialog-intro">按顺序学习，也可以自由选关。星星只看转动次数，提示不扣星。</p>
      <div className="lm-level-chapters">{CHAPTERS.map((chapter, chapterIndex) => <section key={chapter.title} className="lm-level-chapter"><h3><span className="numeric">{chapter.symbol}</span>{chapter.title}<small>{chapter.concept}</small></h3>
        <div className="lm-level-grid">{LEVELS.map((l, i) => l.chapter === chapterIndex && <button key={l.id} className={`lm-level${l.id === level.id ? ' is-active' : ''}`} aria-current={l.id === level.id ? 'step' : undefined} aria-label={`第 ${l.id} 关 ${l.title}${progress.best[l.id] === undefined ? '，未完成' : '，已完成'}`} onClick={() => selectLevel(i)}>
          <span className="lm-level-number numeric">{l.id}</span><span>{l.title}</span><Stars count={progress.best[l.id] === undefined ? 0 : starsFor(progress.best[l.id], l.par)} />
        </button>)}</div></section>)}</div>
    </Modal>}
    {modal === 'help' && <Modal title="怎样折光" opener={modalTrigger.current} close={() => setModal(null)}><div className="lm-rules">{RULES.map((rule) => <div className="lm-rule" key={rule.title}><svg viewBox="-32 -32 64 64" aria-hidden="true"><PieceArt piece={rule.piece} rotation={0} /></svg><div><h3>{rule.title}</h3><p>{rule.text}</p></div></div>)}</div><p className="lm-dialog-intro">暗色方块、接收器和光源都会截住射来的光。可随时撤销、重来或查看提示。三星＝达到目标步数；多用 1–3 次得两星，其余通关得一星。</p><p className="lm-dialog-intro">键盘：Tab 选择镜片，Enter / 空格转动；Z 撤销，R 重来。快捷键在游戏内聚焦时生效。</p><button className="lm-primary" onClick={() => setModal(null)}>明白了，继续实验<ArrowRight size={16} /></button></Modal>}
  </div>;
}
