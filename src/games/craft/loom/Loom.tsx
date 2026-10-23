'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, Check, Download, RotateCcw, Undo2, Volume2, VolumeX } from 'lucide-react';
import { downloadSvg } from '../download';
import { LoomIcon } from '../icons';
import { useCraftSound } from '../sound';
import { useCraftDraft } from '../use-draft';
import { useReducedMotion } from '../use-reduced-motion';
import {
  artifactGeometry, beatRow, canBeat, cellFace, clearLoom, finishLoom, freshLoomDraft, LOOM_CELL_H, LOOM_CELL_W,
  LOOM_CLOTH_LEFT, LOOM_CLOTH_TOP, LOOM_CLOTH_WIDTH, LOOM_ENDS, LOOM_MAX_ROWS, LOOM_SAVE_KEY,
  parseLoomDraft, passComplete, passDirection, resumeLoom, rowColor, setPassProgress, setWeft, shedGroup, startLoom,
  undoLoom, WARP_SCHEMES, warpColor, WEFT_COLORS, type LoomDraft,
} from './engine';

const VIEW_W = 720;
const VIEW_H = 560;
const SHUTTLE_START = LOOM_CLOTH_LEFT - 48;
const SHUTTLE_END = LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH + 48;
const groupName = (group: 0 | 1) => group === 0 ? '甲组' : '乙组';

function LoomThreads({ draft, from, to, liftedOver }: { draft: LoomDraft; from: number; to: number; liftedOver?: boolean }) {
  const shed = shedGroup(draft);
  return <>
    {Array.from({ length: LOOM_ENDS }, (_, end) => {
      const lifted = end % 2 === shed;
      if (liftedOver !== undefined && lifted !== liftedOver) return null;
      const x = LOOM_CLOTH_LEFT + end * LOOM_CELL_W + LOOM_CELL_W / 2 + (lifted ? 3 : -3);
      return <line key={end} x1={x} y1={from} x2={x} y2={to} stroke={warpColor(draft, end)}
        strokeWidth={lifted ? 3.4 : 2.5} strokeLinecap="round" opacity={lifted ? 1 : 0.78} />;
    })}
  </>;
}

function LoomCloth({ draft, x, y, settling }: { draft: LoomDraft; x: number; y: number; settling: number | null }) {
  return <>
    {draft.rows.map((_, index) => <g key={index} className={settling === index ? 'loom-row loom-row--settling' : 'loom-row'}>
      {Array.from({ length: LOOM_ENDS }, (_, end) => {
        const face = cellFace(index, end);
        return <g key={end}>
          <rect x={x + end * LOOM_CELL_W} y={y + index * LOOM_CELL_H} width={LOOM_CELL_W} height={LOOM_CELL_H}
            fill={face === 'warp' ? warpColor(draft, end) : rowColor(draft, index)} />
          {face === 'warp'
            ? <path d={`M${x + end * LOOM_CELL_W + LOOM_CELL_W / 2} ${y + index * LOOM_CELL_H + 2}V${y + (index + 1) * LOOM_CELL_H - 2}`} stroke="#fff" strokeWidth="1" opacity=".16" />
            : <path d={`M${x + end * LOOM_CELL_W + 2} ${y + index * LOOM_CELL_H + LOOM_CELL_H / 2}H${x + (end + 1) * LOOM_CELL_W - 2}`} stroke="#3b2c1c" strokeWidth="1" opacity=".13" />}
        </g>;
      })}
      <path d={`M${x} ${y + (index + 1) * LOOM_CELL_H - 0.5}H${x + LOOM_CLOTH_WIDTH}`} stroke="#4a351f" strokeWidth=".6" opacity=".16" />
    </g>)}
  </>;
}

function ClothArtifact({ draft, svgRef }: { draft: LoomDraft; svgRef?: React.Ref<SVGSVGElement> }) {
  const rows = draft.rows.length;
  const geo = artifactGeometry(rows);
  const rowHeight = rows * LOOM_CELL_H;
  return <svg ref={svgRef} viewBox={`0 0 ${geo.width} ${geo.height}`} className="loom-artifact" role="img"
    aria-label={`织好的布，${rows} 行，带流苏`} xmlns="http://www.w3.org/2000/svg">
    <rect x={geo.x + 4} y={geo.y + 5} width={LOOM_CLOTH_WIDTH} height={rowHeight} fill="#5d4326" opacity=".12" />
    {Array.from({ length: LOOM_ENDS }, (_, end) => {
      const x = geo.x + end * LOOM_CELL_W + LOOM_CELL_W / 2;
      const topLength = geo.fringe - (end % 3) * 3;
      const bottomLength = geo.fringe - ((end + 2) % 3) * 3;
      const color = warpColor(draft, end);
      return <g key={end} stroke={color} strokeWidth="3" strokeLinecap="round">
        <line x1={x} y1={geo.y - topLength} x2={x} y2={geo.y} />
        <line x1={x} y1={geo.y + rowHeight} x2={x} y2={geo.y + rowHeight + bottomLength} />
        <circle cx={x} cy={geo.y} r="2.1" fill={color} stroke="none" />
        <circle cx={x} cy={geo.y + rowHeight} r="2.1" fill={color} stroke="none" />
      </g>;
    })}
    <LoomCloth draft={draft} x={geo.x} y={geo.y} settling={null} />
    <path d={`M${geo.x} ${geo.y}V${geo.y + rowHeight}M${geo.x + LOOM_CLOTH_WIDTH} ${geo.y}V${geo.y + rowHeight}`}
      stroke="#4a351f" strokeWidth="1" opacity=".16" />
  </svg>;
}

export default function Loom() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft<LoomDraft>(LOOM_SAVE_KEY, freshLoomDraft, parseLoomDraft);
  const sound = useCraftSound();
  const reduced = useReducedMotion();
  const [notice, setNotice] = useState('');
  const [settling, setSettling] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const stageRef = useRef<SVGSVGElement>(null);
  const artifactRef = useRef<SVGSVGElement>(null);
  const dragPointer = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const passFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    if (passFrame.current !== null) cancelAnimationFrame(passFrame.current);
  }, []);

  const rows = draft.rows.length;
  const full = rows >= LOOM_MAX_ROWS;
  const shed = shedGroup(draft);
  const direction = passDirection(draft);
  const complete = passComplete(draft);
  const rowTop = LOOM_CLOTH_TOP + rows * LOOM_CELL_H;
  const shuttleX = direction === 1
    ? SHUTTLE_START + (SHUTTLE_END - SHUTTLE_START) * draft.progress
    : SHUTTLE_END - (SHUTTLE_END - SHUTTLE_START) * draft.progress;

  function begin() {
    setDraft(startLoom(draft, draft.warp));
    setNotice('经线已经绷好。拖梭子穿过经线，再把这一行压紧。');
  }

  function advance() {
    if (canBeat(draft)) return;
    if (reduced) {
      setDraft({ ...draft, progress: 1 });
      setNotice('梭子穿过了经线。压紧这一行，它就真正织进布面了。');
      return;
    }
    const from = draft.progress;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 320);
      const eased = 1 - Math.pow(1 - t, 3);
      setDraft((current) => setPassProgress(current, from + (1 - from) * eased));
      if (t < 1) passFrame.current = requestAnimationFrame(tick);
      else {
        passFrame.current = null;
        setNotice('梭子穿过了经线。压紧这一行，它就真正织进布面了。');
      }
    };
    passFrame.current = requestAnimationFrame(tick);
  }

  function beat() {
    if (!canBeat(draft)) return;
    const index = rows;
    setDraft(beatRow(draft));
    sound.play('click');
    setNotice(index + 1 >= LOOM_MAX_ROWS ? '布面织满了。收边后可以导出成品。' : '压紧了。经线换到另一组，继续织下一行。');
    setSettling(index);
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setSettling(null), 320);
  }

  function undo() {
    if (!ready) return;
    const hadPass = draft.progress > 0;
    setDraft(undoLoom(draft));
    setNotice(hadPass ? '退回了梭子。' : rows ? '退掉了一行。' : '还没有可以退的操作。');
  }

  function finish() {
    if (!rows) return;
    setDraft(finishLoom(draft));
    setNotice('');
  }

  function newWork() {
    if (rows > 0 || draft.progress > 0) {
      if (!window.confirm('开始新作会清空当前草稿。已经织好的布请先导出成品。')) return;
    }
    setDraft(clearLoom());
    setNotice('');
  }

  async function exportArtifact() {
    const node = artifactRef.current;
    if (!node || exporting) return;
    setExporting(true);
    const geo = artifactGeometry(rows);
    const width = 1200;
    const ok = await downloadSvg(node, width, Math.round(width * geo.height / geo.width), '聪明山-小小织布机.png');
    setExporting(false);
    setNotice(ok ? '成品已导出。' : '导出失败，请检查浏览器是否拦截了下载。');
  }

  function updatePass(event: PointerEvent<SVGRectElement>) {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const x = (event.clientX - rect.left) / rect.width * VIEW_W;
    const raw = (x - SHUTTLE_START) / (SHUTTLE_END - SHUTTLE_START);
    setDraft((current) => setPassProgress(current, passDirection(current) === 1 ? raw : 1 - raw));
  }

  function pointerDown(event: PointerEvent<SVGRectElement>) {
    if (!ready || draft.finished || full || event.button !== 0) return;
    dragPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updatePass(event);
  }

  function pointerMove(event: PointerEvent<SVGRectElement>) {
    if (dragPointer.current !== event.pointerId) return;
    updatePass(event);
  }

  function pointerUp(event: PointerEvent<SVGRectElement>) {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已经释放 */ }
  }

  const stepText = !complete
    ? draft.progress > 0 ? '梭子走在半途：继续拖，或点「穿完这一行」。' : '拖动梭子，或点「穿完这一行」。'
    : '梭子已经穿过：把这一行压紧。';

  return <div className="container craft-game loom-game" data-ready={ready} data-rows={rows} data-progress={draft.progress.toFixed(3)}
    data-started={draft.started} data-finished={draft.finished}>
    <header className="craft-header">
      <div className="craft-title">
        <Link className="craft-icon-button" href="/game/collections/test/craft" aria-label="返回手工间"><ArrowLeft size={20} /></Link>
        <span className="craft-logo"><LoomIcon /></span>
        <h1>小小织布机 <small>手工间</small></h1>
      </div>
      <div className="craft-actions">
        <button type="button" className="craft-icon-button" onClick={sound.toggle} aria-label={sound.muted ? '开启音效' : '关闭音效'}>
          {sound.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
      </div>
    </header>

    <div className="craft-layout">
      <section className="craft-workspace" aria-label="织布工作台">
        <div className="craft-stage-heading">
          <div>
            <p className="craft-eyebrow">{draft.finished ? '成品' : draft.started ? `第 ${Math.min(rows + 1, LOOM_MAX_ROWS)} 行` : '准备经线'}</p>
            <h2>{draft.finished ? '剪下来的小布块' : draft.started ? (full ? '布面织满了' : '上机织布') : '选一组经线'}</h2>
          </div>
          <span className="craft-status">已织 <span className="numeric">{rows}</span> / {LOOM_MAX_ROWS} 行</span>
        </div>

        {!draft.started ? <div className="loom-setup">
          <p className="loom-setup__lead">经线决定纵向的颜色，之后每一行的纬线可以单独换。</p>
          <div className="loom-warps" aria-label="选择经线配色">
            {WARP_SCHEMES.map((scheme) => <button key={scheme.id} type="button"
              className={`craft-choice${draft.warp === scheme.id ? ' is-active' : ''}`}
              aria-pressed={draft.warp === scheme.id} onClick={() => setDraft({ ...draft, warp: scheme.id })}>
              <span className="craft-choice__swatches" aria-hidden="true">
                {scheme.colors.map((color, index) => <i key={index} style={{ background: color }} />)}
              </span>
              <span className="craft-choice__label">{scheme.name}</span>
            </button>)}
          </div>
          <button type="button" className="craft-primary loom-begin" onClick={begin} disabled={!ready}><Check size={17} />开始织布</button>
        </div> : draft.finished ? <div className="loom-result">
          <div className="loom-result__stage">
            <ClothArtifact draft={draft} svgRef={artifactRef} />
          </div>
          <div className="loom-result__actions">
            <button type="button" className="craft-primary" onClick={exportArtifact} disabled={exporting}>
              <Download size={17} />{exporting ? '正在导出…' : '导出 PNG'}
            </button>
            {rows < LOOM_MAX_ROWS && <button type="button" className="craft-secondary" onClick={() => { setDraft(resumeLoom(draft)); setNotice('可以接着织。'); }}>继续织</button>}
            <button type="button" className="craft-secondary" onClick={newWork}><RotateCcw size={16} />开始新作</button>
          </div>
        </div> : <div className="loom-board-wrap">
          <svg ref={stageRef} className="loom-stage" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img"
            aria-label={`织布机，已织 ${rows} 行。${full ? '布面已满。' : `抬起${groupName(shed)}经线，梭子从${direction === 1 ? '左' : '右'}边出发。`}`}>
            <defs>
              <linearGradient id="loom-wood" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#c29768" /><stop offset=".55" stopColor="#b48755" /><stop offset="1" stopColor="#9c7044" />
              </linearGradient>
              <linearGradient id="loom-bed" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#f4ead7" /><stop offset="1" stopColor="#e8d9be" />
              </linearGradient>
              <clipPath id="loom-clip"><rect x="96" y="58" width="528" height="448" rx="12" /></clipPath>
            </defs>
            <rect x="52" y="44" width="616" height="480" rx="26" fill="url(#loom-wood)" />
            <rect x="68" y="58" width="584" height="448" rx="18" fill="#8c633c" opacity=".32" />
            <rect x="96" y="58" width="528" height="448" rx="12" fill="url(#loom-bed)" />
            <rect x="112" y="70" width="496" height="18" rx="9" fill="#8e6439" />
            <rect x="112" y="456" width="496" height="18" rx="9" fill="#8e6439" />
            <g clipPath="url(#loom-clip)">
              <LoomThreads draft={draft} from={LOOM_CLOTH_TOP} to={470} />
              {!full && <>
                <rect x={LOOM_CLOTH_LEFT} y={rowTop} width={LOOM_CLOTH_WIDTH} height={LOOM_CELL_H} fill="#fbf4e4" opacity=".55" />
                <LoomThreads draft={draft} from={rowTop} to={rowTop + LOOM_CELL_H} liftedOver={false} />
                <path d={direction === 1
                  ? `M${SHUTTLE_START} ${rowTop + LOOM_CELL_H / 2}H${shuttleX}`
                  : `M${shuttleX} ${rowTop + LOOM_CELL_H / 2}H${SHUTTLE_END}`}
                  stroke={WEFT_COLORS[draft.weft].hex} strokeWidth="4.2" strokeLinecap="round" />
                <LoomThreads draft={draft} from={rowTop} to={rowTop + LOOM_CELL_H} liftedOver />
              </>}
              <LoomCloth draft={draft} x={LOOM_CLOTH_LEFT} y={LOOM_CLOTH_TOP} settling={settling} />
              {rows > 0 && <path d={`M${LOOM_CLOTH_LEFT} ${LOOM_CLOTH_TOP + rows * LOOM_CELL_H - .5}H${LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH}`} stroke="#5b4127" strokeWidth="1.4" opacity=".4" />}
              {!full && <g className={dragging ? 'loom-shuttle loom-shuttle--drag' : 'loom-shuttle'}
                style={{ transform: `translate(${shuttleX}px, ${rowTop + LOOM_CELL_H / 2}px) scale(${direction} 1)` }}>
                <path d="M-27 0Q-19-10 1-9L22-1 22 1 1 9Q-19 10-27 0Z" fill="#a9773f" stroke="#6f4a26" strokeWidth="1.3" />
                <rect x="-13" y="-4" width="25" height="8" rx="4" fill={WEFT_COLORS[draft.weft].hex} stroke="#6f4a26" strokeWidth=".7" />
                <path d="M-20 0h-5" stroke="#f0d8a8" strokeWidth="1.3" strokeLinecap="round" />
              </g>}
              {!full && draft.progress === 0 && <g transform={`translate(${direction === 1 ? SHUTTLE_START - 18 : SHUTTLE_END + 18} ${rowTop + LOOM_CELL_H / 2})`}>
                <path d={direction === 1 ? 'M0-8 8 0 0 8' : 'M0-8-8 0 0 8'} fill="none" stroke="#8a6c48" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity=".65" />
              </g>}
              {!full && <rect x="100" y={rowTop - 12} width="520" height="68" fill="transparent" className="loom-drag"
                onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />}
            </g>
          </svg>
          <div className="loom-board-caption">
            <span>抬起 {groupName(shed)} 经线 · 梭子从{direction === 1 ? '左' : '右'}往{direction === 1 ? '右' : '左'}</span>
            <span className="numeric">{Math.round(draft.progress * 100)}%</span>
          </div>
        </div>}

        {draft.started && !draft.finished && <div className="craft-toolbar">
          <button type="button" className="craft-primary" onClick={complete ? beat : advance} disabled={!ready || full}>
            {complete ? <Check size={17} /> : null}{complete ? '压紧这一行' : '穿完这一行'}
          </button>
          <button type="button" className="craft-secondary" onClick={undo} disabled={!ready || (!rows && !draft.progress)}><Undo2 size={16} />撤销</button>
          <button type="button" className="craft-secondary loom-finish" onClick={finish} disabled={!ready || !rows}>收边完成</button>
        </div>}

        <p className={draft.finished ? 'craft-status loom-status--result' : 'craft-status'} role="status" aria-live="polite">
          {notice || (draft.finished ? '成品可以导出，或者继续织几行。' : draft.started ? stepText : '先选经线配色，再开始。')}
        </p>
      </section>

      <aside className="craft-sidebar">
        <section className="craft-panel">
          <h2>纬线颜色</h2>
          <div className="craft-swatches" aria-label="选择这一行的纬线颜色">
            {WEFT_COLORS.map((color, index) => <button key={color.name} type="button"
              className={`craft-swatch${draft.weft === index ? ' is-active' : ''}`} style={{ background: color.hex }}
              aria-label={color.name} aria-pressed={draft.weft === index}
              onClick={() => { setDraft(setWeft(draft, index)); if (draft.started) setNotice('换好了颜色，这一行的纬线会用它。'); }}>
              {draft.weft === index && <Check size={15} />}
            </button>)}
          </div>
          <p className="craft-note">当前：{WEFT_COLORS[draft.weft].name}</p>
        </section>

        <section className="craft-panel">
          <h2>怎么织</h2>
          <ol className="craft-steps">
            <li>拖梭子横穿经线，或点「穿完这一行」。</li>
            <li>点「压紧这一行」把它织进布面。</li>
            <li>压紧后经线会自动换组，再换一种纬线就是条纹。</li>
            <li>随时可以收边；成品带流苏，可导出 PNG。</li>
          </ol>
          <p className="craft-note">每压一行，布面就多一条横向的线；交错的格子是平纹的经线与纬线。</p>
        </section>

        <section className="craft-panel">
          <h2>草稿</h2>
          <p className={saveFailed ? 'craft-note craft-note--warn' : 'craft-note'}>
            {saveFailed ? '浏览器存储不可用：刷新后这份草稿会丢失，请先收边并导出成品。' : '草稿自动保存在此浏览器，刷新可以接着织。'}
          </p>
          {draft.started && <button type="button" className="craft-text-button" onClick={newWork}><RotateCcw size={15} />开始新作</button>}
        </section>
      </aside>
    </div>
  </div>;
}
