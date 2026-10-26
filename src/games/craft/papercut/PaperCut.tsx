'use client';

import { useId, useRef, useState } from 'react';
import { Download, Undo2 } from 'lucide-react';
import { CraftHull, CraftPanel } from '../CraftHull';
import { downloadSvg } from '../download';
import { PaperCutIcon } from '../icons';
import { useCraftDraft } from '../use-draft';
import { useCraftSound } from '../sound';
import {
  FOLD_OPTIONS,
  KERF_WIDTH,
  PAPER_COLORS,
  PAPER_RADIUS,
  PAPER_SAVE_KEY,
  addCut,
  axisCount,
  clampToWedge,
  clearCuts,
  cutMaskShape,
  foldOption,
  freshPaperDraft,
  layerCount,
  layerTransform,
  paperColor,
  parsePaperDraft,
  setPaperColor,
  setPaperFolds,
  setPaperView,
  setUnfold,
  undoCuts,
  wedgeAngle,
  wedgeBoundary,
  type PaperCut,
  type PaperDraft,
  type PaperPoint,
} from './engine';

/**
 * 台面尺寸。
 *
 * 纸面坐标是半径 400 的整圆，而台面比它大不了多少 —— 所以台面上的纸要缩一点
 * （`PAPER_SCALE`），否则纸缘会被台面裁掉。缩放放在绘制那一层，纸面坐标本身
 * 保持 1:1，缝宽之类的几何常量因此不用跟着改。
 */
const VIEW_W = 720;
const VIEW_H = 640;
const CENTER_X = 360;
const CENTER_Y = 320;
const PAPER_SCALE = 0.72;

/** 指针的客户端坐标 → 台面 viewBox 坐标（保持 meet 的留白与缩放）。 */
function toStagePoint(svg: SVGSVGElement, clientX: number, clientY: number): PaperPoint {
  const box = svg.getBoundingClientRect();
  const scale = Math.min(box.width / VIEW_W, box.height / VIEW_H) || 1;
  const offsetX = (box.width - VIEW_W * scale) / 2;
  const offsetY = (box.height - VIEW_H * scale) / 2;
  return { x: (clientX - box.left - offsetX) / scale, y: (clientY - box.top - offsetY) / scale };
}

/** 纸面坐标（圆心 0,0）的折线 → SVG 路径串。 */
function pathOf(points: PaperPoint[], closed = false): string {
  if (!points.length) return '';
  const head = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  const tail = points.slice(1).map((point) => `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('');
  return `${head}${tail}${closed ? 'Z' : ''}`;
}

/**
 * 第 index 层在**展开过程中**的变换（0=还折着，1=完全摊平）。
 *
 * 摊平时它必须与 engine 的 `layerTransform` 逐字对上：偶数层 `rotate(kθ)`，
 * 奇数层 `rotate((k+1)θ) scale(-1 1)`。中间态插值三件事：
 *
 *   · 旋转角从 0 长到它的目标角 —— 纸被一圈圈转开；
 *   · 奇数层的横向缩放从 1 走到 -1，用 `cos(π·spread)` —— 折在下面的那一层是绕着
 *     折痕翻开的，投影到平面就是"宽度先缩到 0（纸侧对着你）、再以镜像的样子张开"。
 *     这条曲线不是凑出来的缓动，而是「绕折痕转 180°」在平面上的样子；
 *   · 折着时每层再偏开一点点（`STACK_FAN`），让"这是一叠纸"看得见 —— 完全对齐的
 *     话 4 层会糊成一块，折了几折就成了屏幕上看不出的数字。
 *
 * 只插值角度、不做那条缩放是不行的：那样奇数层一开始就是镜像的，一叠纸的刀口
 * 会立刻分成两份，"还没折开"这个状态就消失了。
 */
const STACK_FAN = 0.7;

function layerTransformDuring(folds: 2 | 3, index: number, spread: number): string {
  const theta = (wedgeAngle(folds) * 180) / Math.PI;
  const target = index % 2 === 0 ? index * theta : (index + 1) * theta;
  const fan = index * STACK_FAN * (1 - spread);
  const angle = target * spread + fan;
  if (index % 2 === 0) return `rotate(${angle.toFixed(3)})`;
  const squash = Math.cos(Math.PI * spread);
  return `rotate(${angle.toFixed(3)}) scale(${squash.toFixed(4)} 1)`;
}

/**
 * 台面整体的显示旋转（度）。
 *
 * 纸面坐标里楔形占 `[0, θ]` —— 一条折痕竖直朝上，这是对折的物理结果，画出来
 * 就歪在右上方。这里把**整组**纸绕圆心转 −θ/2，让折着的那一叠看起来是一个正对
 * 观众的、尖朝上的扇形。这是纯显示变换：整组一起转是刚性的，铺法、镜像轴、
 * 刀口位置全都不变（扇区只是整体挪了 θ/2）。
 *
 * 代价是手势坐标与导出成品都要跟着反向旋转，见 `pushPoint` 与 `PaperArtifact`。
 */
function displayRotationOf(folds: 2 | 3): number {
  return -((wedgeAngle(folds) * 180) / Math.PI) / 2;
}

export default function PaperCut() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft(PAPER_SAVE_KEY, freshPaperDraft, parsePaperDraft);
  const sound = useCraftSound();
  const [note, setNote] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const stageRef = useRef<SVGSVGElement | null>(null);
  const artifactRef = useRef<SVGSVGElement | null>(null);
  const maskId = useId().replace(/:/g, '');

  /**
   * 正在剪的这一笔。
   *
   * 【为什么独立于草稿】这一笔还没落定：手还在纸上走，它随时可能成为一条细缝、
   * 一个孔洞，或者什么都不算（太短）。写进草稿会让撤销栈塞满半成品，也会让
   * localStorage 每 220ms 存一次没意义的数据。松手时才 `addCut` 落定。
   */
  const [stroke, setStroke] = useState<PaperPoint[]>([]);

  const folds = draft.folds;
  const color = paperColor(draft.color);
  const layers = layerCount(folds);
  const wedgePath = pathOf(wedgeBoundary(folds), true);
  const spread = draft.unfold;

  /**
   * 台面整体的显示旋转 —— 见 `displayRotationOf`。手势坐标要反着转回来。
   */
  const displayRotation = displayRotationOf(folds);

  const pushPoint = (stage: PaperPoint) => {
    // 台面 → 纸面：先减掉纸心、除以台面缩放，再把显示旋转反着转回去。
    const dx = (stage.x - CENTER_X) / PAPER_SCALE;
    const dy = (stage.y - CENTER_Y) / PAPER_SCALE;
    const cos = Math.cos((-displayRotation * Math.PI) / 180);
    const sin = Math.sin((-displayRotation * Math.PI) / 180);
    const raw = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    const paper = clampToWedge(raw.x, raw.y, folds);
    setStroke((current) => {
      const last = current[current.length - 1];
      if (last && Math.hypot(paper.x - last.x, paper.y - last.y) < 2.4) return current;
      return [...current, paper];
    });
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!ready) return;
    const svg = stageRef.current;
    if (!svg) return;
    // 摊平之后看的是成品，不再往"折好的纸"上下刀 —— 要接着剪就先把纸折回去。
    if (spread > 0.98) return;
    setStroke([]);
    pushPoint(toStagePoint(svg, event.clientX, event.clientY));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!stroke.length) return;
    const svg = stageRef.current;
    if (!svg) return;
    pushPoint(toStagePoint(svg, event.clientX, event.clientY));
  };

  const endStroke = (event: React.PointerEvent<SVGSVGElement>) => {
    const points = stroke;
    setStroke([]);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
    if (points.length < 2) return;
    setDraft((current) => {
      const next = addCut(current, points);
      if (next.cuts.length > current.cuts.length) sound.play('snip');
      return next;
    });
  };

  const handleExport = async () => {
    const svg = artifactRef.current;
    if (!svg) return;
    const size = PAPER_RADIUS * 2 + 40;
    const ok = await downloadSvg(svg, size, size, '窗花.png');
    setExportFailed(!ok);
    setNote(ok ? '透明背景的窗花已导出。' : null);
  };

  const status = !ready
    ? '正在读取草稿…'
    : draft.cuts.length === 0
      ? '在折好的纸上划几刀。'
      : spread > 0.98
        ? '完全展开了。'
        : spread > 0
          ? '正在拉开。'
          : `剪了 ${draft.cuts.length} 刀，往右拖把纸拉开。`;

  const workspace = (
    <>
      <div className="craft-stage-heading">
        <div>
          <span className="craft-eyebrow">纸色</span>
          <h2>{color.name}</h2>
        </div>
        <p className="craft-status">{status}</p>
      </div>

      <div className={`paper-stage${draft.view === 'window' ? ' paper-stage--window' : ''}`}>
        <svg
          ref={stageRef}
          className="paper-drag"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="折好的纸与剪口"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        >
          <defs>
            {/*
              被剪掉的地方要从纸里"透"出去（透明底导出靠的就是这个），所以用掩膜而不是
              涂一块背景色。掩膜定义在纸面坐标里（外层 translate 到纸心、掩膜随引用它的
              元素走同一套变换），于是同一张掩膜能把每一层都挖对。
            */}
            <mask id={maskId} maskUnits="userSpaceOnUse" x={-PAPER_RADIUS} y={-PAPER_RADIUS} width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2}>
              <rect x={-PAPER_RADIUS} y={-PAPER_RADIUS} width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2} fill="#fff" />
              {draft.cuts.map((cut) => {
                const shape = cutMaskShape(cut);
                return shape.mode === 'fill'
                  ? <path key={cut.id} d={pathOf(cut.points, true)} fill="#000" />
                  : <path key={cut.id} d={pathOf(cut.points)} stroke="#000" strokeWidth={KERF_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
              })}
              {/* 正在剪的这一笔也算进掩膜 —— 边拖边见口子，不用松手才看到效果。 */}
              {stroke.length > 1
                ? <path d={pathOf(stroke)} stroke="#000" strokeWidth={KERF_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                : null}
            </mask>
          </defs>

          {draft.view === 'window' ? <WindowScene /> : <DeskSurface />}

          <g transform={`translate(${CENTER_X} ${CENTER_Y}) scale(${PAPER_SCALE}) rotate(${displayRotation.toFixed(3)})`}>
            {Array.from({ length: layers }, (_, index) => (
              <g key={index} className="paper-layer" transform={layerTransformDuring(folds, index, spread)}>
                {/* 纸缘厚度：比纸面低一点点的一条深色，读起来才是"一叠纸"而不是一张贴图。
                    它也要一起被挖穿 —— 只给纸面打掩膜的话，刀口上会残留一道深色描边，
                    看着像画了条线，而不是把纸剪透了。 */}
                <g mask={`url(#${maskId})`}>
                  <path d={wedgePath} fill={color.shade} transform="translate(0 1.8)" />
                  <path d={wedgePath} fill={color.fill} />
                </g>
                {/* 两条直边是折痕（也就是展开后的镜像轴），画一道淡线让玩家看见。
                    摊平后折痕就该淡下去 —— 成品是一张纸，不是一张画了格线的图。 */}
                <path
                  d={wedgePath}
                  fill="none"
                  className="paper-layer__crease"
                  opacity={(1 - spread * 0.85).toFixed(3)}
                />
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="craft-caption">
        <span className="craft-gesture-hint">
          {spread > 0.98 ? '刀口已全部摊开' : '在纸上划一刀 · 往右拖把纸拉开'}
        </span>
        <span>{layerCount(folds)} 层 · {layerCount(folds) / 2} 条折痕</span>
      </div>

      {/* 展开进度就在纸下方：手不用在纸和侧栏之间来回。 */}
      <div className="craft-inline-controls">
        <span className="craft-inline-label">展开</span>
        <input
          type="range"
          className="paper-unfold"
          min={0}
          max={100}
          step={1}
          value={Math.round(spread * 100)}
          onChange={(event) => setDraft((current) => setUnfold(current, Number(event.target.value) / 100))}
          aria-label="展开进度"
        />
      </div>

      <div className="craft-toolbar">
        <button
          type="button"
          className="craft-secondary"
          onClick={() => { setDraft(undoCuts); sound.play('click'); }}
          disabled={draft.cuts.length === 0}
        >
          <Undo2 size={16} /> 撤销一刀
        </button>
        <button
          type="button"
          className="craft-secondary"
          onClick={() => {
            setDraft((current) => setPaperView(current, current.view === 'window' ? 'trim' : 'window'));
            sound.play('click');
          }}
        >
          {draft.view === 'window' ? '回到案上' : '放到窗前'}
        </button>
        <button
          type="button"
          className="craft-primary"
          onClick={handleExport}
          disabled={draft.cuts.length === 0}
        >
          <Download size={16} /> 导出 PNG
        </button>
      </div>
      {note ? <p className="craft-status">{note}</p> : null}
      {exportFailed ? <p className="craft-status">导出没有成功，请再试一次。</p> : null}

      <PaperArtifact draft={draft} artifactRef={artifactRef} />
    </>
  );

  const sidebar = (
    <>
      <CraftPanel title="折法">
        <div className="paper-folds">
          {FOLD_OPTIONS.map((option) => (
            <button
              key={option.folds}
              type="button"
              className={`craft-choice${folds === option.folds ? ' is-active' : ''}`}
              onClick={() => { setDraft((current) => setPaperFolds(current, option.folds)); sound.play('click'); }}
              disabled={draft.cuts.length > 0}
              aria-pressed={folds === option.folds}
            >
              <span className="craft-choice__label">{option.name}</span>
              <span className="paper-folds__meta">{option.layers} 层 · {option.axisCount} 条折痕</span>
            </button>
          ))}
        </div>
        {draft.cuts.length > 0 ? <p className="craft-note">已经下刀了，折法不能再换。</p> : null}
        <p className="craft-note">
          折痕就是展开后的镜像轴：{axisCount(folds)} 条，隔 {Math.round(180 / axisCount(folds))}° 一条。
          所以剪一刀会同时出现在每一层上，展开后互为镜像。
        </p>
      </CraftPanel>

      <CraftPanel title="纸色">
        <div className="craft-swatches">
          {PAPER_COLORS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`craft-swatch${draft.color === entry.id ? ' is-active' : ''}`}
              style={{ backgroundColor: entry.fill }}
              onClick={() => { setDraft((current) => setPaperColor(current, entry.id)); sound.play('click'); }}
              aria-label={entry.name}
              aria-pressed={draft.color === entry.id}
            />
          ))}
        </div>
      </CraftPanel>

      <CraftPanel title="草稿">
        <p className="craft-note">剪过的刀口会自动记住，刷新后接着剪。</p>
        {draft.cuts.length > 0
          ? (
            <button
              type="button"
              className="craft-text-button"
              onClick={() => { setDraft(clearCuts); sound.play('click'); }}
            >
              换一张新纸
            </button>
          )
          : null}
        {saveFailed ? <p className="craft-note craft-note--warn">这台浏览器没能保存草稿，刷新后可能丢失。</p> : null}
      </CraftPanel>
    </>
  );

  return (
    <CraftHull
      icon={<PaperCutIcon />}
      title="剪纸窗花"
      gameClass="paper-game"
      attrs={{
        'data-ready': ready ? 'true' : 'false',
        'data-folds': folds,
        'data-cuts': draft.cuts.length,
        'data-unfold': spread.toFixed(3),
        'data-view': draft.view,
      }}
      workspace={workspace}
      sidebar={sidebar}
    />
  );
}

/** 案面：一块木色台面，纸放上去。纯装饰。 */
function DeskSurface() {
  return (
    <g className="paper-desk">
      <rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={24} className="paper-desk__table" />
      <ellipse
        cx={CENTER_X}
        cy={CENTER_Y + 10}
        rx={PAPER_RADIUS * PAPER_SCALE * 0.98}
        ry={PAPER_RADIUS * PAPER_SCALE * 0.98}
        className="paper-desk__shadow"
      />
    </g>
  );
}

/** 窗景：一块带格子的窗玻璃与透进来的光。纯装饰，只为看花纹透光的样子。 */
function WindowScene() {
  return (
    <g className="paper-window">
      <rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={24} className="paper-window__glass" />
      <g className="paper-window__frame">
        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={24} />
        <line x1={VIEW_W / 2} y1={0} x2={VIEW_W / 2} y2={VIEW_H} />
        <line x1={0} y1={VIEW_H / 2} x2={VIEW_W} y2={VIEW_H / 2} />
        <line x1={VIEW_W / 4} y1={0} x2={VIEW_W / 4} y2={VIEW_H} />
        <line x1={(VIEW_W * 3) / 4} y1={0} x2={(VIEW_W * 3) / 4} y2={VIEW_H} />
      </g>
    </g>
  );
}

/**
 * 成品：完全摊平后的窗花，透明底。
 *
 * 与屏幕共用同一份几何（`layerTransform` + `cutMaskShape` + `pathOf`），
 * 所以导出的就是看到的 —— 差异只有"摊平"这一个必然的姿态。
 */
function PaperArtifact({
  draft,
  artifactRef,
}: {
  draft: PaperDraft;
  artifactRef: React.RefObject<SVGSVGElement | null>;
}) {
  const size = PAPER_RADIUS * 2 + 40;
  const color = paperColor(draft.color);
  const wedgePath = pathOf(wedgeBoundary(draft.folds), true);
  const maskId = 'paper-export-mask';

  return (
    <svg
      ref={artifactRef}
      className="craft-export-svg"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-PAPER_RADIUS} y={-PAPER_RADIUS} width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2}>
          <rect x={-PAPER_RADIUS} y={-PAPER_RADIUS} width={PAPER_RADIUS * 2} height={PAPER_RADIUS * 2} fill="#fff" />
          {draft.cuts.map((cut) => {
            const shape = cutMaskShape(cut);
            return shape.mode === 'fill'
              ? <path key={cut.id} d={pathOf(cut.points, true)} fill="#000" />
              : <path key={cut.id} d={pathOf(cut.points)} stroke="#000" strokeWidth={KERF_WIDTH} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
          })}
        </mask>
      </defs>
      <g transform={`translate(${size / 2} ${size / 2}) rotate(${displayRotationOf(draft.folds).toFixed(3)})`}>
        {Array.from({ length: layerCount(draft.folds) }, (_, index) => (
          <g key={index} transform={layerTransform(draft.folds, index)}>
            <path d={wedgePath} fill={color.fill} mask={`url(#${maskId})`} />
          </g>
        ))}
      </g>
    </svg>
  );
}
