'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowLeft, Check, Download, Eye, RotateCcw, Scissors, Undo2, Volume2, VolumeX } from 'lucide-react';
import { downloadSvg } from '../download';
import { PaperCutIcon } from '../icons';
import { useCraftSound } from '../sound';
import { useCraftDraft } from '../use-draft';
import { useReducedMotion } from '../use-reduced-motion';
import {
  addCut, analyzeStroke, clampToWedge, cutMaskShape, FOLD_OPTIONS, foldOption, freshPaperDraft, insideWedge,
  KERF_WIDTH, layerAngle, layerCount, MAX_CUTS, PAPER_COLORS, PAPER_RADIUS, PAPER_SAVE_KEY, paperColor,
  parsePaperDraft, restartPaper, roundTenth, setPaperView, smoothPath, startPaper, undoCuts, wedgeBoundary,
  type PaperCut, type PaperDraft, type PaperPoint,
} from './engine';

const VIEW_W = 720;
const VIEW_H = 640;
// 修剪时楔形纸的尖角留在工作台上方；展开后整张圆纸在画面中央。
// 两个姿态共用一条插值，展开动画才会像同一张纸在长开。
const TRIM_CENTER = { x: 360, y: 466 };
const TRIM_SCALE = 0.78;
const RESULT_CENTER = { x: 360, y: 326 };
const RESULT_SCALE = 0.7;
const WINDOW_CENTER = { x: 360, y: 300 };
const WINDOW_SCALE = 0.55;

function stageTransform(spread: number): string {
  const y = TRIM_CENTER.y + (RESULT_CENTER.y - TRIM_CENTER.y) * spread;
  const scale = TRIM_SCALE + (RESULT_SCALE - TRIM_SCALE) * spread;
  return `translate(${TRIM_CENTER.x} ${y}) scale(${scale})`;
}

function polygonPath(points: PaperPoint[]): string {
  if (!points.length) return '';
  return `M${points.map((point) => `${roundTenth(point.x)} ${roundTenth(point.y)}`).join('L')}Z`;
}

function FoldFan({ folds, color }: { folds: 2 | 3; color: string }) {
  const info = paperColor(color);
  const angle = foldOption(folds).angle;
  const half = angle * Math.PI / 360;
  const r = 52;
  const wedge = `M0 0L${(-r * Math.sin(half)).toFixed(1)} ${(-r * Math.cos(half)).toFixed(1)}A${r} ${r} 0 0 1 ${(r * Math.sin(half)).toFixed(1)} ${(-r * Math.cos(half)).toFixed(1)}Z`;
  return <svg viewBox="-60 -60 120 120" aria-hidden="true" className="paper-fold__art">
    {Array.from({ length: layerCount(folds) }, (_, index) => <path key={index} d={wedge}
      transform={`rotate(${index * angle})`} fill={index % 2 ? info.light : info.fill} stroke={info.shade} strokeWidth=".8" />)}
  </svg>;
}

interface SheetProps {
  uid: string;
  folds: 2 | 3;
  color: string;
  cuts: PaperCut[];
  spread: number;
  stack?: boolean;
}

function PaperSheet({ uid, folds, color, cuts, spread, stack = false }: SheetProps) {
  const info = paperColor(color);
  const wedge = useMemo(() => polygonPath(wedgeBoundary(folds)), [folds]);
  const maskId = `${uid}-mask`;
  const cutMaskId = `${uid}-cut`;
  const fillId = `${uid}-fill`;
  const pieces = cuts.map((cut) => cutMaskShape(cut));
  const layers = layerCount(folds);
  const rimCount = Math.min(layers, 4);
  return <>
    <defs>
      <radialGradient id={fillId} gradientUnits="userSpaceOnUse" cx="0" cy="-40" r={PAPER_RADIUS}>
        <stop offset="0" stopColor={info.light} />
        <stop offset=".58" stopColor={info.fill} />
        <stop offset="1" stopColor={info.fill} />
      </radialGradient>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={-PAPER_RADIUS} y={-PAPER_RADIUS}
        width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2}>
        <path d={wedge} fill="#fff" />
        {pieces.map((piece, index) => piece.mode === 'stroke'
          ? <path key={index} d={piece.d} fill="none" stroke="#000" strokeWidth={KERF_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
          : <path key={index} d={piece.d} fill="#000" />)}
      </mask>
      {/* 叠层只让剪口对齐：每片纸的错位边要留着，但洞口必须一起透到台面去。 */}
      <mask id={cutMaskId} maskUnits="userSpaceOnUse" x={-PAPER_RADIUS} y={-PAPER_RADIUS}
        width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2}>
        <rect x={-PAPER_RADIUS} y={-PAPER_RADIUS} width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2} fill="#fff" />
        {pieces.map((piece, index) => piece.mode === 'stroke'
          ? <path key={index} d={piece.d} fill="none" stroke="#000" strokeWidth={KERF_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
          : <path key={index} d={piece.d} fill="#000" />)}
      </mask>
    </defs>
    {stack && <g opacity=".55" mask={`url(#${cutMaskId})`}>
      {Array.from({ length: rimCount }, (_, index) => {
        const offset = (rimCount - index) * 5;
        return <path key={index} d={wedge} transform={`translate(${offset} ${offset})`}
          fill={index === 0 ? info.shade : info.fill} />;
      })}
    </g>}
    {Array.from({ length: layers }, (_, index) => {
      const angle = layerAngle(folds, index) * spread;
      return <g key={index} transform={`rotate(${angle})`}>
        <g mask={`url(#${maskId})`}>
          <path d={wedge} fill={`url(#${fillId})`} />
          <g stroke={info.light} strokeWidth="1" opacity=".22">
            {[-320, -240, -160, -80, 0, 80, 160, 240, 320].map((y) => <path key={y} d={`M-430 ${y}H430`} />)}
          </g>
        </g>
        <g mask={`url(#${maskId})`}>
          <path d={wedge} fill="none" stroke={info.shade} strokeWidth="1.2" opacity=".38" />
        </g>
      </g>;
    })}
  </>;
}

function CutPreview({ cut }: { cut: Omit<PaperCut, 'id'> }) {
  const shape = cutMaskShape(cut);
  return shape.mode === 'stroke'
    ? <path d={shape.d} fill="none" stroke="#f7b64a" strokeWidth={KERF_WIDTH + 7} strokeLinecap="round" strokeLinejoin="round" opacity=".42" />
    : <path d={shape.d} fill="#f7b64a" fillOpacity=".32" stroke="#8a5300" strokeWidth="2" strokeLinejoin="round" />;
}

function FoldIntro({ uid, folds, color, onDone }: { uid: string; folds: 2 | 3; color: string; onDone: () => void }) {
  const [progress, setProgress] = useState(1);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      setProgress(1 - (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
      else doneRef.current();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div className="paper-intro" onPointerDown={onDone} aria-hidden="true">
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
      <g transform={stageTransform(progress)}>
        <PaperSheet uid={`${uid}-intro`} folds={folds} color={color} cuts={[]} spread={progress} />
      </g>
    </svg>
    <span className="paper-intro__caption">折好了 · 开始剪</span>
  </div>;
}

interface Scrap { id: number; left: number; top: number; color: string; drift: number; spin: number; delay: number }

export default function PaperCutGame() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft<PaperDraft>(PAPER_SAVE_KEY, freshPaperDraft, parsePaperDraft);
  const sound = useCraftSound();
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [notice, setNotice] = useState('');
  const [stroke, setStroke] = useState<PaperPoint[]>([]);
  const [spread, setSpread] = useState(0);
  const [intro, setIntro] = useState(false);
  const [scraps, setScraps] = useState<Scrap[]>([]);
  const [exporting, setExporting] = useState(false);
  const stageRef = useRef<SVGSVGElement>(null);
  const artifactRef = useRef<SVGSVGElement>(null);
  const strokeRef = useRef<PaperPoint[]>([]);
  const drawing = useRef<number | null>(null);
  const lastView = useRef<PaperDraft['view']>('trim');
  const scrapTimers = useRef<number[]>([]);
  const scrapId = useRef(0);

  useEffect(() => () => { for (const timer of scrapTimers.current) window.clearTimeout(timer); }, []);

  useEffect(() => {
    if (!ready) return;
    const previous = lastView.current;
    lastView.current = draft.view;
    if (draft.view === 'trim') { setSpread(0); return; }
    if (draft.view === 'window' || previous === 'window') { setSpread(1); return; }
    if (previous === 'trim') {
      if (reduced) { setSpread(1); return; }
      setSpread(0);
      let frame = 0;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / 820);
        setSpread(1 - Math.pow(1 - t, 3));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    setSpread(1);
  }, [draft.view, ready, reduced]);

  const option = foldOption(draft.folds);
  const info = paperColor(draft.color);
  const layers = layerCount(draft.folds);
  const preview = useMemo(() => stroke.length >= 2 ? analyzeStroke(stroke, draft.folds) : null, [stroke, draft.folds]);
  const cutLabel = draft.cuts.length ? `已剪 ${draft.cuts.length} 刀` : '还没下剪刀';

  function dismissIntro() {
    setIntro(false);
  }

  function begin() {
    if (!ready) return;
    setDraft(startPaper(draft, draft.folds, draft.color));
    setIntro(!reduced);
    setSpread(0);
    setNotice('纸已经折好。在楔形纸上画线，松开手就剪下这一刀。');
  }

  function restart() {
    if (draft.cuts.length && !window.confirm('换一张纸会丢掉这一张的剪法。先导出成品再换？')) return;
    setDraft(restartPaper(draft));
    setIntro(false);
    setSpread(0);
    setStroke([]);
    strokeRef.current = [];
    setNotice('');
  }

  function undo() {
    if (!draft.cuts.length) return;
    setDraft(undoCuts(draft));
    sound.play('click');
    setNotice('把最后一刀补回去了。');
  }

  function toUnfolded() {
    if (!ready) return;
    sound.play('lift');
    setDraft(setPaperView(draft, 'unfolded'));
    setNotice(draft.cuts.length
      ? '沿折线翻开的每一层都带着同一道切口，转一圈就成了对称的花纹。'
      : '还没有剪过。展开是一张完整的圆纸，回去剪几刀再看看。');
  }

  function toWindow() {
    sound.play('lift');
    setDraft(setPaperView(draft, 'window'));
    setNotice('贴到窗上了。透光的地方就是剪掉的纸。');
  }

  function toTrim() {
    sound.play('click');
    setDraft(setPaperView(draft, 'trim'));
    setNotice('回到折好的纸上，可以继续剪。');
  }

  async function exportArtifact() {
    const node = artifactRef.current;
    if (!node || exporting) return;
    setExporting(true);
    const ok = await downloadSvg(node, 1200, 1200, '聪明山-剪纸窗花.png');
    setExporting(false);
    setNotice(ok ? '透明背景的窗花已导出。' : '导出失败，请检查浏览器是否拦截了下载。');
  }

  function toPaper(event: PointerEvent<SVGSVGElement>): PaperPoint {
    const node = stageRef.current ?? event.currentTarget;
    const rect = node.getBoundingClientRect();
    const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H) || 1;
    const offsetX = (rect.width - VIEW_W * scale) / 2;
    const offsetY = (rect.height - VIEW_H * scale) / 2;
    const vx = (event.clientX - rect.left - offsetX) / scale;
    const vy = (event.clientY - rect.top - offsetY) / scale;
    return { x: (vx - TRIM_CENTER.x) / TRIM_SCALE, y: (vy - TRIM_CENTER.y) / TRIM_SCALE };
  }

  function spawnScraps(point: PaperPoint) {
    if (reduced) return;
    const batch: Scrap[] = Array.from({ length: 6 }, (_, index) => ({
      id: (scrapId.current += 1),
      left: (TRIM_CENTER.x + point.x * TRIM_SCALE) / VIEW_W * 100 + (Math.random() - .5) * 2.4,
      top: (TRIM_CENTER.y + point.y * TRIM_SCALE) / VIEW_H * 100 + (Math.random() - .5) * 1.6,
      color: index % 3 === 0 ? info.light : index % 3 === 1 ? info.fill : info.shade,
      drift: 10 + Math.random() * 34,
      spin: 120 + Math.random() * 320,
      delay: Math.random() * 140,
    }));
    setScraps((current) => [...current, ...batch].slice(-24));
    const timer = window.setTimeout(() => {
      const ids = new Set(batch.map((scrap) => scrap.id));
      setScraps((current) => current.filter((scrap) => !ids.has(scrap.id)));
    }, 1_100);
    scrapTimers.current.push(timer);
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (!ready || intro || draft.view !== 'trim' || event.button !== 0) return;
    const point = toPaper(event);
    if (!insideWedge(point.x, point.y, draft.folds)) return;
    const start = clampToWedge(point.x, point.y, draft.folds);
    drawing.current = event.pointerId;
    strokeRef.current = [start];
    setStroke([start]);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 某些浏览器不支持 */ }
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (drawing.current !== event.pointerId) return;
    const point = toPaper(event);
    const clamped = clampToWedge(point.x, point.y, draft.folds);
    setStroke((current) => {
      if (current.length >= 700) return current;
      const last = current[current.length - 1];
      if (last && Math.hypot(clamped.x - last.x, clamped.y - last.y) < 2.4) return current;
      const next = [...current, { x: roundTenth(clamped.x), y: roundTenth(clamped.y) }];
      strokeRef.current = next;
      return next;
    });
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    if (drawing.current !== event.pointerId) return;
    drawing.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已经释放 */ }
    const points = strokeRef.current;
    strokeRef.current = [];
    setStroke([]);
    if (points.length < 2) return;
    const cut = analyzeStroke(points, draft.folds);
    if (!cut) { setNotice('这一笔太短，或者没有剪到纸上。再画长一点。'); return; }
    if (draft.cuts.length >= MAX_CUTS) { setNotice('这一张已经剪满了。展开看看，或者换一张纸。'); return; }
    sound.play('snip');
    spawnScraps(points[points.length - 1]);
    setDraft((current) => addCut(current, points));
    setNotice(cut.kind === 'hole' ? '剪出一个孔洞。接下来它会沿折线重复成一圈。'
      : cut.kind === 'pocket' ? '从纸边剪掉了一块。展开时会变成对称的缺口。'
        : '剪开一道细缝。细缝展开后会变成放射状的花纹。');
  }

  const trimLabel = `折好的${info.name}纸，${option.name}，${layers} 层，${cutLabel}`;

  return <div className="container craft-game paper-game" data-ready={ready} data-started={draft.started}
    data-view={draft.view} data-cuts={draft.cuts.length}>
    <header className="craft-header">
      <div className="craft-title">
        <Link className="craft-icon-button" href="/game/collections/craft" aria-label="返回手工间"><ArrowLeft size={20} /></Link>
        <span className="craft-logo"><PaperCutIcon /></span>
        <h1>剪纸窗花 <small>手工间</small></h1>
      </div>
      <div className="craft-actions">
        <button type="button" className="craft-icon-button" onClick={sound.toggle} aria-label={sound.muted ? '开启音效' : '关闭音效'}>
          {sound.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
      </div>
    </header>

    <div className="craft-layout">
      <section className="craft-workspace" aria-label="剪纸工作台">
        <div className="craft-stage-heading">
          <div>
            <p className="craft-eyebrow">{!draft.started ? '准备纸样' : draft.view === 'trim' ? '修剪' : draft.view === 'unfolded' ? '展开' : '窗前'}</p>
            <h2>{!draft.started ? '选纸与折法' : draft.view === 'trim' ? '在折好的纸上剪' : draft.view === 'unfolded' ? '展开的样子' : '贴上窗'}</h2>
          </div>
          <span className="craft-status">{draft.started ? <>{cutLabel} · <span className="numeric">{layers}</span> 层</> : `${option.name} · ${layers} 层`}</span>
        </div>

        {!draft.started ? <div className="paper-setup">
          <p className="paper-setup__lead">折得越多，展开后的花纹越密。先选一张纸，再选折法。</p>
          <div className="paper-folds" aria-label="选择折法">
            {FOLD_OPTIONS.map((entry) => <button key={entry.folds} type="button"
              className={`craft-choice paper-fold${draft.folds === entry.folds ? ' is-active' : ''}`}
              aria-pressed={draft.folds === entry.folds} onClick={() => setDraft({ ...draft, folds: entry.folds })}>
              <FoldFan folds={entry.folds} color={draft.color} />
              <span className="paper-fold__label">{entry.name}</span>
              <span className="paper-fold__meta">{entry.layers} 层 · 每层 {entry.angle}°</span>
            </button>)}
          </div>
          <h3 className="paper-setup__label">纸色</h3>
          <div className="craft-swatches" aria-label="选择纸色">
            {PAPER_COLORS.map((color) => <button key={color.id} type="button"
              className={`craft-swatch${draft.color === color.id ? ' is-active' : ''}`}
              style={{ background: color.fill }} aria-label={color.name} aria-pressed={draft.color === color.id}
              onClick={() => setDraft({ ...draft, color: color.id })}>
              {draft.color === color.id && <Check size={15} />}
            </button>)}
          </div>
          <button type="button" className="craft-primary paper-begin" onClick={begin} disabled={!ready}><Scissors size={17} />开始剪</button>
        </div> : draft.view === 'trim' ? <>
          <div className="paper-stage-wrap">
            <svg ref={stageRef} className="paper-stage" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={trimLabel}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
              <g transform={stageTransform(0)}>
                <PaperSheet uid={`${uid}-trim`} folds={draft.folds} color={draft.color} cuts={draft.cuts} spread={0} stack />
                {stroke.length > 1 && <path d={smoothPath(stroke)} fill="none" stroke="#7a4d14" strokeWidth="2.4"
                  strokeDasharray="7 6" strokeLinecap="round" opacity=".7" />}
                {preview && <CutPreview cut={preview} />}
              </g>
            </svg>
            <div className="paper-scraps" aria-hidden="true">
              {scraps.map((scrap) => <i key={scrap.id} className="paper-scrap" style={{
                left: `${scrap.left}%`, top: `${scrap.top}%`, background: scrap.color,
                '--scrap-drift': `${scrap.drift}px`, '--scrap-spin': `${scrap.spin}deg`, '--scrap-delay': `${scrap.delay}ms`,
              } as CSSProperties} />)}
            </div>
            {intro && <FoldIntro uid={uid} folds={draft.folds} color={draft.color} onDone={dismissIntro} />}
          </div>
          <div className="paper-board-caption">
            <span>在纸上下笔 · 松开剪刀完成剪切</span>
            <span className="numeric">{draft.cuts.length} / {MAX_CUTS} 刀</span>
          </div>
          <div className="craft-toolbar">
            <button type="button" className="craft-primary" onClick={toUnfolded} disabled={!ready}><Eye size={17} />展开看看</button>
            <button type="button" className="craft-secondary" onClick={undo} disabled={!draft.cuts.length}><Undo2 size={16} />撤销这一刀</button>
            <button type="button" className="craft-secondary" onClick={restart}><RotateCcw size={16} />换一张纸</button>
          </div>
        </> : draft.view === 'unfolded' ? <div className="paper-result">
          <div className="paper-result__stage">
            <svg className="paper-stage paper-stage--result" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
              aria-label={`${info.name}窗花展开图，${option.name}，${cutLabel}`}>
              <g transform={stageTransform(spread)}>
                <PaperSheet uid={`${uid}-view`} folds={draft.folds} color={draft.color} cuts={draft.cuts} spread={spread} />
              </g>
            </svg>
          </div>
          <div className="craft-toolbar">
            <button type="button" className="craft-primary" onClick={toWindow}><Eye size={17} />放到窗前</button>
            <button type="button" className="craft-secondary" onClick={toTrim}><Scissors size={16} />返回修剪</button>
            <button type="button" className="craft-secondary" onClick={exportArtifact} disabled={exporting}><Download size={16} />{exporting ? '正在导出…' : '导出 PNG'}</button>
          </div>
        </div> : <div className="paper-result">
          <div className="paper-window">
            <svg className="paper-window__scene" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
              aria-label={`${info.name}窗花贴在窗上的样子`}>
              <defs>
                <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#a8d8ef" /><stop offset="1" stopColor="#eaf6f9" />
                </linearGradient>
                <linearGradient id={`${uid}-wood`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#9a744c" /><stop offset="1" stopColor="#7c5a3a" />
                </linearGradient>
              </defs>
              <rect width={VIEW_W} height={VIEW_H} fill="#ded3c0" />
              <rect width={VIEW_W} height={VIEW_H} fill="#7a644a" opacity=".06" />
              <rect x="52" y="40" width="616" height="470" rx="10" fill="url(#${uid}-wood)" />
              <rect x="78" y="66" width="564" height="418" rx="4" fill="url(#${uid}-sky)" />
              <circle cx="540" cy="146" r="38" fill="#f6d488" opacity=".85" />
              <g fill="#fff" opacity=".7">
                <ellipse cx="196" cy="150" rx="62" ry="22" /><ellipse cx="236" cy="134" rx="40" ry="19" />
                <ellipse cx="430" cy="214" rx="52" ry="17" /><ellipse cx="464" cy="202" rx="32" ry="15" />
              </g>
              <path d="M78 420q120-64 240-18t324-26v108H78Z" fill="#b7d6c0" opacity=".55" />
              <path d="M78 452q150-38 300-6t264-16v54H78Z" fill="#8bb59a" opacity=".45" />
              <rect x="360" y="66" width="7" height="418" fill="url(#${uid}-wood)" opacity=".9" />
              <rect x="78" y="272" width="564" height="7" fill="url(#${uid}-wood)" opacity=".9" />
              <g transform={`translate(${WINDOW_CENTER.x} ${WINDOW_CENTER.y}) scale(${WINDOW_SCALE})`}>
                <PaperSheet uid={`${uid}-window`} folds={draft.folds} color={draft.color} cuts={draft.cuts} spread={1} />
              </g>
              <rect x="38" y="500" width="644" height="26" rx="6" fill="#8a6644" />
              <rect x="38" y="500" width="644" height="8" rx="4" fill="#a9835c" />
            </svg>
          </div>
          <div className="craft-toolbar">
            <button type="button" className="craft-primary" onClick={exportArtifact} disabled={exporting}><Download size={17} />{exporting ? '正在导出…' : '导出 PNG'}</button>
            <button type="button" className="craft-secondary" onClick={toTrim}><Scissors size={16} />取下继续剪</button>
            <button type="button" className="craft-secondary" onClick={toUnfolded}><Eye size={16} />看展开图</button>
          </div>
          <p className="paper-window__caption">透明背景导出只带窗花本身，阴影与窗景不会跟着走。</p>
        </div>}

        <p className="craft-status" role="status" aria-live="polite">
          {notice || (!draft.started ? '选好纸色和折法，开始剪第一张。'
            : draft.view === 'trim' ? (draft.cuts.length ? '继续剪，或者展开看看对称的花纹。' : '从纸边剪到纸边，或者画一个闭合的圈。')
              : draft.view === 'unfolded' ? '剪掉的部分会透出背景。满意就放到窗前，或者回去再补几刀。'
                : '窗景只是预览；导出的图片是透明背景的窗花。')}
        </p>
      </section>

      <aside className="craft-sidebar">
        {draft.started && <section className="craft-panel">
          <h2>这一张</h2>
          <div className="paper-info">
            <span className="paper-info__swatch" style={{ background: info.fill }} aria-hidden="true" />
            <div>
              <strong>{info.name}纸</strong>
              <p>{option.name} · <span className="numeric">{layers}</span> 层 · <span className="numeric">{draft.cuts.length}</span> 刀</p>
            </div>
          </div>
          <button type="button" className="craft-text-button" onClick={restart}><RotateCcw size={15} />换一张纸</button>
        </section>}

        <section className="craft-panel">
          <h2>怎么剪</h2>
          <ol className="craft-steps">
            <li>在折好的楔形纸上下笔，线要落在纸内。</li>
            <li>从一边纸边剪到另一边，会切掉靠得近的那一侧。</li>
            <li>画一个闭合的圈，纸中间就多一个孔洞。</li>
            <li>展开后每一层都重复同一道切口，对称花纹就是这样来的。</li>
          </ol>
          <p className="craft-note">笔画会经过剪刀的自动修整；剪歪了随时撤销这一刀。</p>
        </section>

        <section className="craft-panel">
          <h2>草稿</h2>
          <p className={saveFailed ? 'craft-note craft-note--warn' : 'craft-note'}>
            {saveFailed ? '浏览器存储不可用：刷新后这张纸会丢失，满意时请先导出 PNG。' : '剪法自动保存在此浏览器，刷新可以接着剪。'}
          </p>
          {draft.started && draft.view !== 'trim' && <button type="button" className="craft-text-button" onClick={toTrim}><Scissors size={15} />回到修剪</button>}
        </section>
      </aside>
    </div>

    <svg ref={artifactRef} className="paper-export" width="1200" height="1200"
      viewBox={`${-PAPER_RADIUS - 40} ${-PAPER_RADIUS - 40} ${(PAPER_RADIUS + 40) * 2} ${(PAPER_RADIUS + 40) * 2}`}
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <PaperSheet uid={`${uid}-export`} folds={draft.folds} color={draft.color} cuts={draft.cuts} spread={1} />
    </svg>
  </div>;
}
