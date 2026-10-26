'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, RefreshCw, Undo2 } from 'lucide-react';
import { CraftHull, CraftPanel } from '../CraftHull';
import { downloadCanvas } from '../download';
import { MarblingIcon } from '../icons';
import { useCraftDraft } from '../use-draft';
import { useCraftSound } from '../sound';
import {
  MARBLING_COLORS,
  MARBLING_H,
  MARBLING_PALETTES,
  MARBLING_SAVE_KEY,
  MARBLING_W,
  clearMarbling,
  colorValueAt,
  combStroke,
  decodeGrid,
  dropPaint,
  freshMarbling,
  gridHasPaint,
  marblingPalette,
  needleStroke,
  parseMarblingDraft,
  reprintMarbling,
  setMarblingColor,
  setMarblingLay,
  setMarblingPalette,
  setMarblingTool,
  undoMarbling,
  valueHex,
  withGrid,
  type MarblingTool,
} from './engine';

/** 台面尺寸。水面与纸共用这一块。 */
const VIEW_W = 720;
const VIEW_H = 560;
/** 水面在台面上的矩形。 */
const POOL = { x: 88, y: 76, w: 544, h: 380 };
/**
 * 画布相对网格的放大倍率。
 *
 * 网格本身已经是 480×336；再乘 1 就够（SVG 的 `<image>` 会做平滑放大）。乘大多
 * 只是把内存翻倍 —— 颜料是无损放大的，多出来的像素不会更清晰。
 */
const SUPERSAMPLE = 1;

const WATER_RGB: [number, number, number] = [222, 236, 233];
const PAPER_RGB: [number, number, number] = [244, 237, 221];

/** 指针的客户端坐标 → 网格坐标 + 纵向比例。 */
function toGrid(svg: SVGSVGElement, clientX: number, clientY: number) {
  const box = svg.getBoundingClientRect();
  const scale = Math.min(box.width / VIEW_W, box.height / VIEW_H) || 1;
  const offsetX = (box.width - VIEW_W * scale) / 2;
  const offsetY = (box.height - VIEW_H * scale) / 2;
  const stageX = (clientX - box.left - offsetX) / scale;
  const stageY = (clientY - box.top - offsetY) / scale;
  return {
    x: ((stageX - POOL.x) / POOL.w) * MARBLING_W,
    y: ((stageY - POOL.y) / POOL.h) * MARBLING_H,
    stageX,
    stageY,
    inside: stageX >= POOL.x && stageX <= POOL.x + POOL.w && stageY >= POOL.y && stageY <= POOL.y + POOL.h,
  };
}
/**
 * 纸的下沿在台面上的 y —— 也就是 `lay` 与手指位置的唯一换算关系。
 *
 * lay=0 时下沿正好在水面顶边（纸只露在水面上方一道），lay=1 时下沿压到水面底边
 * （整张纸盖住了水）。于是"抓纸沿从水面顶拖到水面底"就是 0 → 1，手感与画面同一件事。
 */
const PAPER_EDGE = 26;
/** 抓纸的容差（台面单位）。比纸沿本身宽一点，手指按不准也能抓住。 */
const GRAB_SLOP = 34;
/** 松手时的吸附：差这么一点就算拖到底 / 揭到底，不用手指精确停在边上。 */
const LAY_SNAP = 0.09;

function paperBottomY(lay: number): number {
  return POOL.y + lay * POOL.h;
}

/** `paperBottomY` 的逆函数：手指的台面 y → 纸的覆盖进度。 */
function layAtStageY(stageY: number): number {
  return (stageY - POOL.y) / POOL.h;
}

/** 网格 → canvas；`print` 为真时按"颜料吸在纸上"混合。 */
function paintCanvas(canvas: HTMLCanvasElement, grid: Uint8Array, print: boolean): string {
  canvas.width = MARBLING_W * SUPERSAMPLE;
  canvas.height = MARBLING_H * SUPERSAMPLE;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const gy = Math.min(MARBLING_H - 1, Math.floor(y / SUPERSAMPLE));
    for (let x = 0; x < canvas.width; x += 1) {
      const gx = Math.min(MARBLING_W - 1, Math.floor(x / SUPERSAMPLE));
      const hex = valueHex(grid[gy * MARBLING_W + gx]);
      const offset = (y * canvas.width + x) * 4;
      // 纸纤维：一点点确定性噪点，让成品看起来是吸在纸上的，而不是打印的色块。
      const fiber = (((x * 7 + y * 13) % 11) / 11 - 0.5) * (print ? 7 : 3);
      if (!hex) {
        const base = print ? PAPER_RGB : WATER_RGB;
        image.data[offset] = base[0] + fiber;
        image.data[offset + 1] = base[1] + fiber;
        image.data[offset + 2] = base[2] + fiber;
      } else {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        if (print) {
          // 颜料是半透明的：以纸色为底做一次正片叠底，白纸处的留白才不是死白。
          image.data[offset] = (r * PAPER_RGB[0]) / 255 + fiber;
          image.data[offset + 1] = (g * PAPER_RGB[1]) / 255 + fiber;
          image.data[offset + 2] = (b * PAPER_RGB[2]) / 255 + fiber;
        } else {
          image.data[offset] = r + fiber;
          image.data[offset + 1] = g + fiber;
          image.data[offset + 2] = b + fiber;
        }
      }
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

export default function Marbling() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft(MARBLING_SAVE_KEY, freshMarbling, parseMarblingDraft);
  const sound = useCraftSound();
  const [note, setNote] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const printRef = useRef<HTMLCanvasElement | null>(null);
  /** 上一次的网格坐标（拖拽用）。 */
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  /** 铺纸手势的起点进度；非 null 表示当前手势在铺/揭纸。 */
  const layRef = useRef<number | null>(null);

  const palette = marblingPalette(draft.palette);
  /** 当前网格。草稿里存的是游程编码，渲染与手势都要真数组。 */
  const grid = useMemo(() => decodeGrid(draft.cells) ?? new Uint8Array(MARBLING_W * MARBLING_H), [draft.cells]);
  const printedGrid = useMemo(() => (draft.print ? decodeGrid(draft.print) : null), [draft.print]);

  /**
   * 水面与成品两幅位图。
   *
   * 【为什么先画进 canvas 再以 `<image>` 引用】SVG 里放不了 canvas，而逐格画四万个
   * `<rect>` 既慢又是马赛克。网格先铺进一块小 canvas，再让 SVG 平滑放大 —— 边界
   * 自然融开，正是水面上颜料该有的样子。
   *
   * 【为什么用 state 存 data URL】渲染期读 ref 会拿到上一帧的图像。改成"画完存进
   * state"，画面就与网格严格同一步。
   */
  const [waterUrl, setWaterUrl] = useState('');
  const [printUrl, setPrintUrl] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) setWaterUrl(paintCanvas(canvas, grid, false));
  }, [grid]);

  useEffect(() => {
    const canvas = printRef.current;
    if (!canvas) return;
    setPrintUrl(printedGrid ? paintCanvas(canvas, printedGrid, true) : '');
  }, [printedGrid]);

  /** 提交一次改动画面的手势（滴、针、梳）—— 记一步历史。 */
  const applyGrid = (next: Uint8Array) => {
    setDraft((current) => withGrid(current, next));
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!ready) return;
    const svg = stageRef.current;
    if (!svg) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toGrid(svg, event.clientX, event.clientY);

    /**
     * 【怎么分清"改颜料"和"铺纸"】两者都在同一块画面上，靠**抓在哪儿**分：
     * 落在纸的下沿附近（或纸已经盖住水面时落在纸上）就是抓纸，其余都是往水里下工具。
     *
     * 不靠 `stage` 分，因为纸在 lay=0 时也是一直挂在那里的 —— 玩家随时能把它拖下来，
     * 不需要先按一个"铺纸"按钮把状态切过去。这正是这一款最该连贯的地方。
     */
    const grabLine = paperBottomY(draft.lay);
    const onPaper = draft.stage === 'print'
      || Math.abs(point.stageY - grabLine) <= GRAB_SLOP
      // 纸已经盖住一部分时，落在纸身上也算抓纸 —— 手在纸中间往下压同样自然。
      || (draft.lay > 0.02 && point.stageY <= grabLine);
    if (onPaper) {
      layRef.current = draft.lay;
      setDragging(true);
      return;
    }

    if (!point.inside) return;
    lastRef.current = { x: point.x, y: point.y };

    if (draft.tool === 'drop') {
      const value = colorValueAt(draft.palette, draft.color);
      applyGrid(dropPaint(grid, point.x, point.y, value));
      sound.play('drop');
    } else {
      sound.play('swish');
    }
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = stageRef.current;
    if (!svg) return;
    const point = toGrid(svg, event.clientX, event.clientY);

    /**
     * 铺纸/揭纸：**绝对映射** —— 纸的下沿就跟着手指走。
     *
     * `paperBottomY` 的逆函数：手指在哪，纸的下沿就到哪。与织布机、剪纸的展开滑杆
     * 同理，逐帧累加会在方向翻转时把进度拽回去。
     *
     * 手指拖出画面上下边界时，`lay` 自己会被夹到 0 或 1 —— 所以"一路拖到底"
     * 不需要手指精确停在池边，甩出去就算数。
     */
    if (layRef.current !== null) {
      const lay = layAtStageY(point.stageY);
      setDraft((current) => setMarblingLay(current, lay));
      return;
    }

    if (!lastRef.current) return;
    const from = lastRef.current;
    const next = { x: point.x, y: point.y };
    if (Math.hypot(next.x - from.x, next.y - from.y) < 0.6) return;
    lastRef.current = next;
    applyGrid(draft.tool === 'comb' ? combStroke(grid, from, next) : needleStroke(grid, from, next));
  };

  const endStroke = (event: React.PointerEvent<SVGSVGElement>) => {
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
    if (layRef.current !== null) {
      layRef.current = null;
      setDragging(false);
      /**
       * 松手时吸附到两头。
       *
       * 拖到 0.93 就停手是最常见的情况，差这一点点却会留在"纸还盖着一半"的中间态上，
       * 而那个状态既没有成品、也不方便再下工具 —— 一次干净的吸附把"拖到底"变成
       * 一个不需要瞄准的动作。中间区间（0.09..0.91）则老老实实停在那里。
       */
      setDraft((current) => {
        if (current.lay >= 1 - LAY_SNAP) return setMarblingLay(current, 1);
        if (current.lay <= LAY_SNAP) return setMarblingLay(current, 0);
        return current;
      });
      if (draft.stage === 'print') sound.play('peel');
      else if (draft.lay > 0.5) sound.play('lay');
    }
    lastRef.current = null;
  };

  const handleExport = async () => {
    const canvas = printRef.current;
    if (!canvas) return;
    setBusy(true);
    const ok = await downloadCanvas(canvas, '水面印花.png');
    setBusy(false);
    setExportFailed(!ok);
    setNote(ok ? '成品已导出。' : null);
  };

  const painted = gridHasPaint(grid);
  const hasPrint = draft.print !== null;

  const status = !ready
    ? '正在读取草稿…'
    : draft.stage === 'print' && hasPrint
      ? '这张已经揭起来了。'
      : draft.lay > 0.98
        ? '纸贴住了水面，往上拖揭起来。'
        : draft.lay > 0.02
          ? '纸正盖下去，拖到底再往上揭。'
          : painted
            ? '再滴几滴，或用针和梳子拉出纹理。'
            : '先在水面上滴几滴颜料。';

  const workspace = (
    <>
      <div className="craft-stage-heading">
        <div>
          <span className="craft-eyebrow">{palette.name}</span>
          <h2>{colorName(palette.colors[draft.color])}</h2>
        </div>
        <p className="craft-status">{status}</p>
      </div>

      <div className="marbling-stage">
        <svg
          ref={stageRef}
          className={`marbling-drag${dragging ? ' is-dragging' : ''}`}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="水面与纸"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        >
          <defs>
            <clipPath id="marbling-pool-clip">
              <rect x={POOL.x} y={POOL.y} width={POOL.w} height={POOL.h} rx={14} />
            </clipPath>
          </defs>

          {/* 盆：一圈厚边，里面是水。 */}
          <rect x={POOL.x - 20} y={POOL.y - 20} width={POOL.w + 40} height={POOL.h + 40} rx={26} className="marbling-tray" />
          <rect x={POOL.x} y={POOL.y} width={POOL.w} height={POOL.h} rx={14} className="marbling-water" />

          {/* 颜料。铺满水面矩形，靠平滑放大融开边界。
              纸画在它上面，所以盖住的那一段自然看不见 —— "纸把花纹吸走了"。 */}
          <g clipPath="url(#marbling-pool-clip)">
            {waterUrl ? (
              <image
                href={waterUrl}
                x={POOL.x}
                y={POOL.y}
                width={POOL.w}
                height={POOL.h}
                preserveAspectRatio="none"
              />
            ) : null}
          </g>

          {/* 纸：一直挂在画面上方，下沿跟着手指走。 */}
          {draft.stage !== 'print' ? <PaperOverlay lay={draft.lay} /> : null}

          {/* 成品：贴在台面中央的一张纸。 */}
          {draft.stage === 'print' && printUrl ? (
            <g className="marbling-print">
              <rect x={POOL.x - 8} y={POOL.y - 8} width={POOL.w + 16} height={POOL.h + 16} rx={18} className="marbling-print__frame" />
              <image href={printUrl} x={POOL.x} y={POOL.y} width={POOL.w} height={POOL.h} preserveAspectRatio="none" />
            </g>
          ) : null}
        </svg>

        {/* 离屏画布：网格与成品都画在这里，再以 data URL 引用。 */}
        <canvas ref={canvasRef} className="marbling-offscreen" aria-hidden="true" />
        <canvas ref={printRef} className="marbling-offscreen" aria-hidden="true" />
      </div>

      <div className="craft-caption">
        <span className="craft-gesture-hint">
          {draft.stage === 'print'
            ? '换一盆清水可以再印一张'
            : dragging
              ? '往下拖盖住水面 · 往上拖揭起来'
              : '点一下滴一滴 · 按住拖动拉纹理 · 抓纸沿上下拖'}
        </span>
        <span>{painted ? '水面已有颜料' : '水面还空着'}</span>
      </div>

      {/* 工具就在水盆下方：手不离画面就能换。 */}
      <div className="craft-inline-controls marbling-tools">
        {MARBLING_TOOL_LIST.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`marbling-tool${draft.tool === tool.id ? ' is-active' : ''}`}
            onClick={() => { setDraft((current) => setMarblingTool(current, tool.id)); sound.play('click'); }}
            aria-pressed={draft.tool === tool.id}
          >
            {tool.label}
          </button>
        ))}
        <div className="craft-swatches">
          {palette.colors.map((hex, index) => (
            <button
              key={hex}
              type="button"
              className={`craft-swatch${draft.color === index ? ' is-active' : ''}`}
              style={{ backgroundColor: hex }}
              onClick={() => { setDraft((current) => setMarblingColor(current, index)); sound.play('click'); }}
              aria-label={colorName(hex)}
              aria-pressed={draft.color === index}
            />
          ))}
        </div>
      </div>

      <div className="craft-toolbar">
        <button
          type="button"
          className="craft-secondary"
          onClick={() => { setDraft(undoMarbling); sound.play('click'); }}
          disabled={draft.history.length === 0}
        >
          <Undo2 size={16} /> 撤销一步
        </button>
        {draft.stage === 'print' ? (
          <>
            <button
              type="button"
              className="craft-secondary"
              onClick={() => { setDraft(reprintMarbling); sound.play('click'); }}
            >
              <RefreshCw size={16} /> 再印一张
            </button>
            <button type="button" className="craft-primary" onClick={handleExport} disabled={busy}>
              <Download size={16} /> 导出 PNG
            </button>
          </>
        ) : (
          <button
            type="button"
            className="craft-secondary"
            onClick={() => { setDraft(clearMarbling); sound.play('click'); }}
            disabled={!painted && draft.lay === 0}
          >
            <RefreshCw size={16} /> 换一盆清水
          </button>
        )}
      </div>
      {note ? <p className="craft-status">{note}</p> : null}
      {exportFailed ? <p className="craft-status">导出没有成功，请再试一次。</p> : null}
    </>
  );

  const sidebar = (
    <>
      <CraftPanel title="调色板">
        <div className="marbling-palettes">
          {MARBLING_PALETTES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`craft-choice${draft.palette === entry.id ? ' is-active' : ''}`}
              onClick={() => { setDraft((current) => setMarblingPalette(current, entry.id)); sound.play('click'); }}
              aria-pressed={draft.palette === entry.id}
            >
              <span className="craft-choice__swatches">
                {entry.colors.map((hex) => <i key={hex} style={{ backgroundColor: hex }} />)}
              </span>
              <span className="craft-choice__label">{entry.name}</span>
            </button>
          ))}
        </div>
        <p className="craft-note">换调色板只影响下一滴 —— 已经落在水里的颜料不会变色。</p>
      </CraftPanel>

      <CraftPanel title="水面">
        <p className="craft-note">水面上的颜料会自动记住，刷新后接着画。</p>
        <p className="craft-note">
          水面上共 {MARBLING_COLORS.length} 种颜色，分在 {MARBLING_PALETTES.length} 组调色板里。
        </p>
        {saveFailed ? <p className="craft-note craft-note--warn">这台浏览器没能保存草稿，刷新后可能丢失。</p> : null}
      </CraftPanel>
    </>
  );

  return (
    <CraftHull
      icon={<MarblingIcon />}
      title="水面印花"
      gameClass="marbling-game"
      attrs={{
        'data-ready': ready ? 'true' : 'false',
        'data-stage': draft.stage,
        'data-tool': draft.tool,
        'data-painted': painted ? 'true' : 'false',
        'data-lay': draft.lay.toFixed(3),
        'data-print': hasPrint ? 'true' : 'false',
      }}
      workspace={workspace}
      sidebar={sidebar}
    />
  );
}

const MARBLING_TOOL_LIST: { id: MarblingTool; label: string }[] = [
  { id: 'drop', label: '滴管' },
  { id: 'needle', label: '针' },
  { id: 'comb', label: '梳子' },
];

/** 调色板里的每个颜色配一个中文名（只用于可读标签，不影响渲染）。 */
const COLOR_NAMES: Record<string, string> = {
  '#0f766e': '深青', '#14b8a6': '碧绿', '#0ea5e9': '天蓝', '#f0c04a': '姜黄', '#e85d4a': '朱砂', '#f3ede0': '米白',
  '#b23a48': '绛红', '#e76f51': '珊瑚', '#f4a261': '杏橙', '#e9c46a': '沙金', '#2a9d8f': '松绿', '#f6f1e6': '浅米',
  '#1e3a8a': '夜蓝', '#2563eb': '靛蓝', '#38bdf8': '浅蓝', '#a7f3d0': '薄荷', '#f5f3ff': '雪白', '#fbbf24': '琥珀',
  '#9d174d': '梅红', '#db2777': '桃红', '#f472b6': '粉红', '#fbcfe8': '藕粉', '#7c3aed': '紫罗兰', '#fef3c7': '奶黄',
};

function colorName(hex: string): string {
  return COLOR_NAMES[hex.toLowerCase()] ?? '颜料';
}

/**
 * 水面上的那张纸。
 *
 * 它**一直挂在那里**（不是按状态出现/消失）：下沿就是可以抓的那条线，往上拖是揭、
 * 往下拖是盖。`lay` 只决定纸盖住了水面的多少，所以纸的位置与手势进度是同一件事。
 *
 * 纸画在水面之上（`marbling-print` 之外的顺序），所以盖住的部分看不见颜料 ——
 * 这正好是“纸把花纹吸走了”的视觉：印花落在纸上，水面那一片就露白。
 */
function PaperOverlay({ lay }: { lay: number }) {
  const bottom = paperBottomY(lay);
  // 纸从画面上方垂下来，一直盖到它的下沿；下沿之上是纸，之下是水面。
  const top = -PAPER_EDGE * 2;
  return (
    <g className="marbling-paper">
      <rect
        x={POOL.x - 12}
        y={top}
        width={POOL.w + 24}
        height={bottom - top}
        className="marbling-paper__sheet"
        transform={`rotate(${(1 - lay) * -2.2} ${POOL.x + POOL.w / 2} ${bottom})`}
      />
      {/* 纸沿：一条略深的横线，就是能抓的那条线。 */}
      <line
        x1={POOL.x - 12}
        y1={bottom}
        x2={POOL.x + POOL.w + 12}
        y2={bottom}
        className="marbling-paper__edge"
        transform={`rotate(${(1 - lay) * -2.2} ${POOL.x + POOL.w / 2} ${bottom})`}
      />
    </g>
  );
}
