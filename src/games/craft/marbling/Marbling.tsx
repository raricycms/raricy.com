'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, Check, Download, Droplet, Layers, RotateCcw, Undo2, Volume2, VolumeX } from 'lucide-react';
import { downloadCanvas } from '../download';
import { CombIcon, MarblingIcon, NeedleIcon } from '../icons';
import { useCraftSound } from '../sound';
import { useCraftDraft } from '../use-draft';
import {
  combStroke, decodeGrid, dropPaint, emptyGrid, freshMarbling, gridHasPaint,
  MARBLING_EMPTY, MARBLING_H, MARBLING_MAX_HISTORY, MARBLING_PALETTES, MARBLING_SAVE_KEY, MARBLING_W,
  encodeGrid, marblingPalette, needleStroke, parseMarblingDraft, printMarbling, setMarblingColor,
  setMarblingPalette, setMarblingTool, type MarblingDraft, type MarblingPrint, type MarblingTool,
} from './engine';

type RGB = [number, number, number];
const WATER: RGB = [222, 236, 233];
const PAPER: RGB = [244, 237, 221];

const TOOLS: { id: MarblingTool; name: string; hint: string }[] = [
  { id: 'drop', name: '滴管', hint: '点一下水面滴入一滴颜料。后滴的颜色会把先前的花纹推开。' },
  { id: 'needle', name: '针', hint: '按住拖动，针尖会拉出局部的弧线。' },
  { id: 'comb', name: '梳子', hint: '按住拖动，梳齿会拉出一排平行的纹理。' },
];

function hexToRgb(hex: string): RGB {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * 把低分辨率色格放大成水盆或纸上的画面。水盆保留底色与水光；印张走纸底 + 正片叠底，
 * 空白格保持纸面，最后补一层纸纤维。导出的画布走同一份函数，屏幕上与文件里不会两样。
 */
function paintGrid(target: HTMLCanvasElement, buffer: HTMLCanvasElement, grid: Uint8Array,
  paletteId: string, mode: 'water' | 'print'): void {
  const colors = marblingPalette(paletteId).colors.map(hexToRgb);
  buffer.width = MARBLING_W;
  buffer.height = MARBLING_H;
  const bufferContext = buffer.getContext('2d');
  if (!bufferContext) return;
  const image = bufferContext.createImageData(MARBLING_W, MARBLING_H);
  const data = image.data;
  for (let i = 0; i < grid.length; i += 1) {
    const value = grid[i];
    const offset = i * 4;
    if (value === MARBLING_EMPTY) {
      if (mode === 'print') { data[offset + 3] = 0; continue; }
      data[offset] = WATER[0]; data[offset + 1] = WATER[1]; data[offset + 2] = WATER[2]; data[offset + 3] = 255;
    } else {
      const rgb = colors[value] ?? WATER;
      data[offset] = rgb[0]; data[offset + 1] = rgb[1]; data[offset + 2] = rgb[2]; data[offset + 3] = 255;
    }
  }
  bufferContext.putImageData(image, 0, 0);
  const context = target.getContext('2d');
  if (!context) return;
  const width = target.width;
  const height = target.height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (mode === 'print') {
    context.fillStyle = '#f4eddd';
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'multiply';
    context.globalAlpha = 0.96;
    context.drawImage(buffer, 0, 0, width, height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = 'rgba(120, 98, 62, .08)';
    context.lineWidth = Math.max(1, width / 1000);
    for (let line = 0; line < 22; line += 1) {
      const y = (line + 0.5) / 22 * height;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y + Math.sin(line * 1.7) * 3);
      context.stroke();
    }
    context.strokeStyle = 'rgba(120, 98, 62, .16)';
    context.lineWidth = Math.max(1, width / 800);
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
  } else {
    context.drawImage(buffer, 0, 0, width, height);
    const sheen = context.createLinearGradient(0, 0, width, height);
    sheen.addColorStop(0, 'rgba(255, 255, 255, .2)');
    sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(1, 'rgba(23, 58, 52, .08)');
    context.fillStyle = sheen;
    context.fillRect(0, 0, width, height);
  }
}

function PrintSheet({ print }: { print: MarblingPrint }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const buffer = useRef<HTMLCanvasElement | null>(null);
  const grid = useMemo(() => decodeGrid(print.cells), [print.cells]);
  useEffect(() => {
    if (!ref.current || !grid) return;
    if (!buffer.current) buffer.current = document.createElement('canvas');
    paintGrid(ref.current, buffer.current, grid, print.palette, 'print');
  }, [grid, print.palette]);
  return <canvas ref={ref} width={1000} height={700} className="marbling-print__canvas"
    role="img" aria-label="印好的水面印花" />;
}

export default function Marbling() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft<MarblingDraft>(MARBLING_SAVE_KEY, freshMarbling, parseMarblingDraft);
  const sound = useCraftSound();
  const [version, setVersion] = useState(0);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState(false);
  const waterRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<Uint8Array>(emptyGrid());
  const history = useRef<Uint8Array[]>([]);
  const drag = useRef<{ pointer: number; last: { x: number; y: number }; tool: 'needle' | 'comb'; started: boolean } | null>(null);

  useEffect(() => {
    if (!ready) return;
    const decoded = decodeGrid(draft.cells);
    if (decoded) {
      gridRef.current = decoded;
      setVersion((value) => value + 1);
      setHistoryDepth(history.current.length);
    }
  }, [ready, draft.cells]);

  useEffect(() => {
    if (!ready || !waterRef.current) return;
    if (!bufferRef.current) bufferRef.current = document.createElement('canvas');
    paintGrid(waterRef.current, bufferRef.current, gridRef.current, draft.palette, 'water');
  }, [ready, version, draft.palette, draft.stage]);

  const palette = marblingPalette(draft.palette);
  const tool = TOOLS.find((entry) => entry.id === draft.tool) ?? TOOLS[0];
  const painted = gridHasPaint(gridRef.current);
  const print = draft.print;
  const printedGrid = useMemo(() => print ? decodeGrid(print.cells) : null, [print]);

  function redraw(grid: Uint8Array) {
    if (!waterRef.current) return;
    if (!bufferRef.current) bufferRef.current = document.createElement('canvas');
    paintGrid(waterRef.current, bufferRef.current, grid, draft.palette, 'water');
  }

  function remember(grid: Uint8Array) {
    history.current.push(grid);
    if (history.current.length > MARBLING_MAX_HISTORY) history.current.shift();
    setHistoryDepth(history.current.length);
  }

  function commit(grid: Uint8Array) {
    gridRef.current = grid;
    setDraft((current) => ({ ...current, cells: encodeGrid(grid) }));
    setVersion((value) => value + 1);
  }

  function pointAt(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(MARBLING_W, (event.clientX - rect.left) / rect.width * MARBLING_W)),
      y: Math.max(0, Math.min(MARBLING_H, (event.clientY - rect.top) / rect.height * MARBLING_H)),
    };
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!ready || draft.stage !== 'water' || event.button !== 0) return;
    event.preventDefault();
    const point = pointAt(event);
    if (draft.tool === 'drop') {
      const next = dropPaint(gridRef.current, point.x, point.y, draft.color);
      remember(gridRef.current);
      redraw(next);
      commit(next);
      sound.play('drop');
      setNotice('滴入一滴颜料。再滴别的颜色，会把这一圈往外推开。');
      return;
    }
    drag.current = { pointer: event.pointerId, last: point, tool: draft.tool, started: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 某些浏览器不支持 */ }
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const point = pointAt(event);
    if (Math.hypot(point.x - state.last.x, point.y - state.last.y) < 1.2) return;
    if (!state.started) {
      remember(gridRef.current);
      state.started = true;
    }
    const next = state.tool === 'needle'
      ? needleStroke(gridRef.current, state.last, point)
      : combStroke(gridRef.current, state.last, point);
    gridRef.current = next;
    redraw(next);
    state.last = point;
  }

  function pointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已经释放 */ }
    if (!state.started) return;
    commit(gridRef.current);
    sound.play('swish');
    setNotice(state.tool === 'needle' ? '针尖拖出了一道弧线。继续拖，或者换梳子。' : '梳齿拉出了一排平行的纹理。');
  }

  function undo() {
    const previous = history.current.pop();
    if (!previous) return;
    setHistoryDepth(history.current.length);
    gridRef.current = previous;
    redraw(previous);
    setDraft((current) => ({ ...current, cells: encodeGrid(previous) }));
    setVersion((value) => value + 1);
    sound.play('click');
    setNotice('退回上一笔。');
  }

  function clearWater() {
    if (!painted) { setNotice('水面已经是干净的。'); return; }
    if (!window.confirm('清空水面会丢掉这一盆颜料。满意的话先用纸印下来。')) return;
    const empty = emptyGrid();
    history.current = [];
    setHistoryDepth(0);
    gridRef.current = empty;
    redraw(empty);
    setDraft((current) => ({ ...current, cells: encodeGrid(empty), print: null, stage: 'water' }));
    setVersion((value) => value + 1);
    setNotice('水面已经清空。');
  }

  function choosePalette(id: string) {
    if (id === draft.palette) return;
    setDraft(setMarblingPalette(draft, id));
    sound.play('click');
    setNotice('换了配色；水里已有的颜料会一起变色。');
  }

  function chooseColor(color: number) {
    setDraft(setMarblingColor(draft, color));
    sound.play('click');
  }

  function chooseTool(next: MarblingTool) {
    setDraft(setMarblingTool(draft, next));
    sound.play('click');
    setNotice(TOOLS.find((entry) => entry.id === next)?.hint ?? '');
  }

  function layPaper() {
    if (!ready || draft.stage !== 'water') return;
    if (!painted) { setNotice('水面还是空的，先滴几滴颜料。'); return; }
    sound.play('click');
    setDraft((current) => ({ ...current, stage: 'paper' }));
    setNotice('纸覆在水面上，颜料被吸进了纸里。揭起来看看。');
  }

  function liftPaper() {
    sound.play('lift');
    const snapshot = printMarbling(gridRef.current, draft.palette);
    setDraft((current) => ({ ...current, stage: 'print', print: snapshot }));
    setNotice('揭起来就是这张印张。可以导出，或者再印一张。');
  }

  function newPrint() {
    if (!window.confirm('再印一张会清空水面和这张印张；满意的话先导出 PNG。')) return;
    const empty = emptyGrid();
    history.current = [];
    setHistoryDepth(0);
    gridRef.current = empty;
    setDraft((current) => ({ ...current, cells: encodeGrid(empty), print: null, stage: 'water' }));
    setNotice('换了一盆清水，重新滴颜料吧。');
  }

  async function exportPrint() {
    if (!print || !printedGrid || exporting) return;
    setExporting(true);
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1120;
    const buffer = document.createElement('canvas');
    paintGrid(canvas, buffer, printedGrid, print.palette, 'print');
    const ok = await downloadCanvas(canvas, '聪明山-水面印花.png');
    setExporting(false);
    setNotice(ok ? '印张已导出。' : '导出失败，请检查浏览器是否拦截了下载。');
  }

  const heading = draft.stage === 'water' ? '滴颜料，拖出纹理' : draft.stage === 'paper' ? '纸吸住了花纹' : '揭起来的样子';
  const eyebrow = draft.stage === 'water' ? '水盆' : draft.stage === 'paper' ? '覆纸' : '印张';

  return <div className="container craft-game marbling-game" data-ready={ready} data-stage={draft.stage}
    data-tool={draft.tool} data-painted={painted}>
    <header className="craft-header">
      <div className="craft-title">
        <Link className="craft-icon-button" href="/game/collections/test/craft" aria-label="返回手工间"><ArrowLeft size={20} /></Link>
        <span className="craft-logo"><MarblingIcon /></span>
        <h1>水面印花 <small>手工间</small></h1>
      </div>
      <div className="craft-actions">
        <button type="button" className="craft-icon-button" onClick={sound.toggle} aria-label={sound.muted ? '开启音效' : '关闭音效'}>
          {sound.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
      </div>
    </header>

    <div className="craft-layout">
      <section className="craft-workspace" aria-label="水面印花工作台">
        <div className="craft-stage-heading">
          <div>
            <p className="craft-eyebrow">{eyebrow}</p>
            <h2>{heading}</h2>
          </div>
          <span className="craft-status">{palette.name} · {painted ? '水面有颜料' : '清水'}</span>
        </div>

        {(draft.stage === 'water' || draft.stage === 'paper') && <>
          <div className="marbling-tray">
            <canvas ref={waterRef} width={1000} height={700} className="marbling-canvas" role="img"
              aria-label={`水面。当前工具：${tool.name}。${tool.hint}`}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} />
            {draft.stage === 'paper' && <div className="marbling-paper" aria-hidden="true" />}
          </div>
          <div className="marbling-caption">
            <span>{draft.stage === 'paper' ? '纸已经覆在水面上 · 揭起后颜料转到纸上' : tool.hint}</span>
            <span className="numeric">{painted ? '已上色' : '清水'}</span>
          </div>
        </>}

        {draft.stage === 'water' && <div className="craft-toolbar">
          <button type="button" className="craft-primary marbling-lay" onClick={layPaper} disabled={!ready}><Layers size={17} />铺纸</button>
          <button type="button" className="craft-secondary" onClick={undo} disabled={!historyDepth}><Undo2 size={16} />撤销</button>
          <button type="button" className="craft-secondary" onClick={clearWater} disabled={!painted}><RotateCcw size={16} />清空水面</button>
        </div>}

        {draft.stage === 'paper' && <div className="craft-toolbar">
          <button type="button" className="craft-primary" onClick={liftPaper}><Layers size={17} />揭起纸</button>
        </div>}

        {draft.stage === 'print' && <div className="marbling-result">
          <div className="marbling-print">
            {print && printedGrid ? <PrintSheet print={print} /> : <p className="craft-note">这张印张没有存下来，请再印一张。</p>}
          </div>
          <div className="craft-toolbar">
            <button type="button" className="craft-primary" onClick={exportPrint} disabled={exporting || !printedGrid}><Download size={17} />{exporting ? '正在导出…' : '导出 PNG'}</button>
            <button type="button" className="craft-secondary" onClick={newPrint}><RotateCcw size={16} />再印一张</button>
          </div>
          <p className="marbling-print__note">印张带着纸的底色和纤维；导出的是 1600 × 1120 的 PNG。</p>
        </div>}

        <p className="craft-status" role="status" aria-live="polite">
          {notice || (draft.stage === 'water' ? '先滴几滴颜料，再用针或梳子拖出纹理。'
            : draft.stage === 'paper' ? '纸已经盖住水面，点「揭起纸」把花纹转到纸上。'
              : '这张印张已经可以导出，或者再印一张新的。')}
        </p>
      </section>

      <aside className="craft-sidebar">
        <section className="craft-panel">
          <h2>配色</h2>
          <div className="marbling-palettes">
            {MARBLING_PALETTES.map((entry) => <button key={entry.id} type="button"
              className={`marbling-palette${entry.id === draft.palette ? ' is-active' : ''}`}
              aria-pressed={entry.id === draft.palette} onClick={() => choosePalette(entry.id)}>
              <span className="marbling-palette__dots" aria-hidden="true">
                {entry.colors.map((color) => <i key={color} style={{ background: color }} />)}
              </span>
              <span className="marbling-palette__name">{entry.name}</span>
              {entry.id === draft.palette && <Check size={14} />}
            </button>)}
          </div>
          <p className="craft-note">换配色会同时改变水里已有的颜料，花纹的位置不变。</p>
        </section>

        <section className="craft-panel">
          <h2>颜料</h2>
          <div className="craft-swatches" aria-label="选择颜料">
            {palette.colors.map((color, index) => <button key={color} type="button"
              className={`craft-swatch${draft.color === index ? ' is-active' : ''}`}
              style={{ background: color }} aria-label={`第 ${index + 1} 种颜料`} aria-pressed={draft.color === index}
              onClick={() => chooseColor(index)}>
              {draft.color === index && <Check size={15} />}
            </button>)}
          </div>
          <p className="craft-note">滴管每次只落一滴；颜色选好后点水面。</p>
        </section>

        <section className="craft-panel">
          <h2>工具</h2>
          <div className="marbling-tools" role="group" aria-label="选择工具">
            {TOOLS.map((entry) => <button key={entry.id} type="button"
              className={`marbling-tool${draft.tool === entry.id ? ' is-active' : ''}`}
              aria-pressed={draft.tool === entry.id} onClick={() => chooseTool(entry.id)}>
              {entry.id === 'drop' ? <Droplet size={19} /> : entry.id === 'needle' ? <NeedleIcon /> : <CombIcon />}
              <span>{entry.name}</span>
            </button>)}
          </div>
          <p className="craft-note">{tool.hint}</p>
        </section>

        <section className="craft-panel">
          <h2>怎么印</h2>
          <ol className="craft-steps">
            <li>点水面滴入颜料；后滴的颜色会推开先前的。</li>
            <li>针拖出弧线，梳子拉出一排平行纹理。</li>
            <li>点「铺纸」把纸覆在水面，再「揭起纸」。</li>
            <li>满意就导出 PNG；不满意可以回到清水重来。</li>
          </ol>
        </section>

        <section className="craft-panel">
          <h2>草稿</h2>
          <p className={saveFailed ? 'craft-note craft-note--warn' : 'craft-note'}>
            {saveFailed ? '浏览器存储不可用：刷新后这一盆水会丢失，满意时请先印下并导出。' : '水面与印张自动保存在此浏览器，刷新可以接着印。'}
          </p>
          {draft.stage === 'water' && painted && <button type="button" className="craft-text-button" onClick={clearWater}><RotateCcw size={15} />换一盆清水</button>}
          {draft.stage === 'print' && <button type="button" className="craft-text-button" onClick={newPrint}><RotateCcw size={15} />再印一张</button>}
        </section>
      </aside>
    </div>
  </div>;
}
