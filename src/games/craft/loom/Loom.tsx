'use client';

import { useRef, useState } from 'react';
import { Check, Download, RefreshCw, Undo2 } from 'lucide-react';
import { CraftHull, CraftPanel } from '../CraftHull';
import { downloadSvg } from '../download';
import { LoomIcon } from '../icons';
import { useCraftDraft } from '../use-draft';
import { useCraftSound } from '../sound';
import {
  LOOM_CELL_H,
  LOOM_CELL_W,
  LOOM_CLOTH_HEIGHT,
  LOOM_CLOTH_LEFT,
  LOOM_CLOTH_TOP,
  LOOM_CLOTH_WIDTH,
  LOOM_ENDS,
  LOOM_MAX_ROWS,
  LOOM_SAVE_KEY,
  WARP_SCHEMES,
  WEFT_COLORS,
  artifactGeometry,
  canWeave,
  cellFace,
  currentRow,
  dragWeft,
  finishLoom,
  freshLoomDraft,
  isFull,
  parseLoomDraft,
  passDirection,
  resumeLoom,
  rowColor,
  setWarp,
  setWeft,
  shedGroup,
  undoLoom,
  warpColor,
  weftColor,
  type LoomDraft,
} from './engine';

const VIEW_W = 720;
const VIEW_H = 600;

const BENCH_TOP = LOOM_CLOTH_TOP - 34;
const BENCH_BOTTOM = LOOM_CLOTH_TOP + LOOM_CLOTH_HEIGHT + 26;
/** 布面的下沿。第 0 行贴着这里，往上长（见 LoomCloth 的生长方向）。 */
const CLOTH_BOTTOM = LOOM_CLOTH_TOP + LOOM_CLOTH_HEIGHT;
const SHUTTLE_W = 42;

/**
 * 指针横坐标 → 用户的 x 坐标。viewBox 是默认的 xMidYMid meet，两侧可能有留白，
 * 所以换算要按 min(宽比, 高比) 缩放，再减掉居中留下的偏移。
 */
function toUserX(svg: SVGSVGElement, clientX: number): number {
  const box = svg.getBoundingClientRect();
  const scale = Math.min(box.width / VIEW_W, box.height / VIEW_H);
  const offsetX = (box.width - VIEW_W * scale) / 2;
  return (clientX - box.left - offsetX) / scale;
}

export default function Loom() {
  const { draft, setDraft, ready, saveFailed } = useCraftDraft(LOOM_SAVE_KEY, freshLoomDraft, parseLoomDraft);
  const sound = useCraftSound();
  const [note, setNote] = useState<string | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const artifactRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<SVGSVGElement | null>(null);
  /** 上一次的指针 x。位移要按帧累加，所以必须记住上一帧在哪。 */
  const lastXRef = useRef<number | null>(null);
  /**
   * 指针事件的权威状态。
   *
   * 一次拖动里会连续来几十个 pointermove，React 的渲染跟不上这个频率，闭包里的 `draft`
   * 永远是「上一帧渲染时」的那份 —— 拿它算 progress 会让每一个事件都从同一个旧值起算，
   * 结果进度要么原地打转、要么直接跳。所以手势一律读这个 ref（每次提交同步写回），
   * 渲染仍然只用 `draft`。这是"手势跟手"与"React 是异步渲染"之间必须搭的那座桥。
   */
  const liveRef = useRef(draft);
  liveRef.current = draft;

  /** 提交一次手势结果：ref 与 state 一起更新，保证下一个事件看到的是最新的。 */
  const commit = (next: LoomDraft) => {
    liveRef.current = next;
    setDraft(next);
  };

  const rows = draft.rows.length;

  /**
   * 指针 x → 这一趟走了多少。**绝对映射**：梭子就在手底下，指针在布的那一头就是 0、
   * 另一头就是 1（反向那一趟倒过来）。
   *
   * 【为什么用绝对映射而不是逐帧位移累加】累加看着更"跟手"，实际会坏在两处：
   *   1. 到岸那一刻方向就翻面了，手却还在往同一个方向走 —— 多出来的位移在新方向上
   *      正好是"往回拽"，刚织好的那一行会被自己退掉（实测行数在 1 和 0 之间反复抖）。
   *   2. 每个事件都要从上一帧的 progress 起算，一旦丢了事件，误差会一直留着。
   * 绝对映射没有这两个问题：丢一帧只是梭子停一下，下一帧自然对上；到岸后手继续往前
   * 也只是停在岸边，不会误判成反悔。
   */
  const progressAt = (userX: number, direction: 1 | -1): number => {
    const t = (userX - LOOM_CLOTH_LEFT) / LOOM_CLOTH_WIDTH;
    const clamped = Math.max(0, Math.min(1, t));
    return direction === 1 ? clamped : 1 - clamped;
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = stageRef.current;
    if (!svg || lastXRef.current === null) return;
    const userX = toUserX(svg, event.clientX);
    if (userX === lastXRef.current) return;
    lastXRef.current = userX;

    const current = liveRef.current;
    const next = dragWeft(current, progressAt(userX, passDirection(current)));
    if (next.rows.length > current.rows.length) sound.play('thread');
    commit(next);
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!ready || draft.finished) return;
    const svg = stageRef.current;
    if (!svg) return;
    lastXRef.current = toUserX(svg, event.clientX);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    lastXRef.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
  };

  const handleExport = async () => {
    const svg = artifactRef.current;
    if (!svg) return;
    const geometry = artifactGeometry(draft.rows.length);
    const ok = await downloadSvg(svg, geometry.width, geometry.height, '织布.png');
    setExportFailed(!ok);
    setNote(ok ? '成品已导出。' : null);
  };

  const full = isFull(draft);
  const status = !ready
    ? '正在读取草稿…'
    : draft.finished
      ? '已经收边了。'
      : full
        ? '布面织满了，可以收边。'
        : dragging
          ? '拖到对岸就织好一行。'
          : rows === 0
            ? '按住布面拖过去，梭子跟着手走。'
            : draft.progress > 0
              ? '梭子还没走到对岸，接着拖。'
              : '来回拖，一行一行织下去。';

  const workspace = (
    <>
      <div className="craft-stage-heading">
        <div>
          <span className="craft-eyebrow">梭线</span>
          <h2>{WEFT_COLORS[draft.weft]?.name ?? WEFT_COLORS[0].name}</h2>
        </div>
        <p className="craft-status">{status}</p>
      </div>

      <div className="loom-bench">
        <svg
          ref={stageRef}
          className={`loom-stage${dragging ? ' is-dragging' : ''}`}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="织布机台面"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <LoomFrame />
          <LoomCloth draft={draft} />
          {!draft.finished && canWeave(draft) ? <LoomShuttle draft={draft} /> : null}
        </svg>
      </div>

      <div className="craft-caption">
        <span className="craft-gesture-hint">
          {rows === 0 ? '左右拖动织第一行' : '拖到对岸织一行 · 往回拽反悔一行'}
        </span>
        <span>
          {rows} / {LOOM_MAX_ROWS} 行
        </span>
      </div>

      {/* 线轴架就在机架下方：换线在手边，视线不用在台面和侧栏之间来回。 */}
      <div className="craft-inline-controls loom-spools">
        <span className="craft-inline-label">梭线</span>
        <div className="craft-swatches">
          {WEFT_COLORS.map((color, index) => (
            <button
              key={color.name}
              type="button"
              className={`craft-swatch${draft.weft === index ? ' is-active' : ''}`}
              style={{ backgroundColor: color.hex }}
              onClick={() => { setDraft((current) => setWeft(current, index)); sound.play('click'); }}
              aria-label={color.name}
              aria-pressed={draft.weft === index}
            />
          ))}
        </div>
      </div>

      <div className="craft-toolbar">
        <button
          type="button"
          className="craft-secondary"
          onClick={() => { setDraft(undoLoom); sound.play('click'); }}
          disabled={draft.progress === 0 && rows === 0 && !draft.finished}
        >
          <Undo2 size={16} /> 退回一趟
        </button>
        {draft.finished ? (
          <>
            <button type="button" className="craft-secondary" onClick={() => { setDraft(resumeLoom); sound.play('click'); }}>
              <RefreshCw size={16} /> 接着织
            </button>
            <button type="button" className="craft-primary" onClick={handleExport}>
              <Download size={16} /> 导出 PNG
            </button>
          </>
        ) : (
          <button
            type="button"
            className="craft-primary"
            onClick={() => { setDraft(finishLoom); sound.play('done'); }}
            disabled={rows === 0}
          >
            <Check size={16} /> 收边完成
          </button>
        )}
      </div>
      {note ? <p className="craft-status">{note}</p> : null}
      {exportFailed ? <p className="craft-status">导出没有成功，请再试一次。</p> : null}

      {rows > 0 ? <LoomArtifact draft={draft} artifactRef={artifactRef} /> : null}
    </>
  );

  const sidebar = (
    <>
      <CraftPanel title="经线">
        <div className="loom-warps-choice">
          {WARP_SCHEMES.map((scheme) => (
            <button
              key={scheme.id}
              type="button"
              className={`craft-choice${draft.warp === scheme.id ? ' is-active' : ''}`}
              onClick={() => { setDraft((current) => setWarp(current, scheme.id)); sound.play('click'); }}
              disabled={rows > 0 || draft.progress > 0}
              aria-pressed={draft.warp === scheme.id}
            >
              <span className="craft-choice__swatches">
                {scheme.colors.slice(0, 6).map((hex, index) => (
                  <i key={index} style={{ backgroundColor: hex }} />
                ))}
              </span>
              <span className="craft-choice__label">{scheme.name}</span>
            </button>
          ))}
        </div>
        {rows > 0 || draft.progress > 0
          ? <p className="craft-note">已经上机了，经线不能再换。</p>
          : null}
      </CraftPanel>

      <CraftPanel title="草稿">
        <p className="craft-note">织了几行会自动记住，刷新后接着织。</p>
        {saveFailed ? <p className="craft-note craft-note--warn">这台浏览器没能保存草稿，刷新后可能丢失。</p> : null}
      </CraftPanel>
    </>
  );

  return (
    <CraftHull
      icon={<LoomIcon />}
      title="小小织布机"
      gameClass="loom-game"
      attrs={{
        'data-ready': ready ? 'true' : 'false',
        'data-rows': rows,
        'data-progress': draft.progress.toFixed(3),
        'data-finished': draft.finished ? 'true' : 'false',
      }}
      workspace={workspace}
      sidebar={sidebar}
    />
  );
}

/** 机架：两根立柱、上下横梁、经线辊。纯装饰，不接手势。 */
function LoomFrame() {
  const left = LOOM_CLOTH_LEFT - 44;
  const right = LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH + 44;
  return (
    <g className="loom-frame">
      <rect x={left} y={BENCH_TOP} width={right - left} height={BENCH_BOTTOM - BENCH_TOP} rx={12} className="loom-frame__beam" />
      <rect x={left + 10} y={BENCH_TOP + 10} width={right - left - 20} height={BENCH_BOTTOM - BENCH_TOP - 20} rx={8} className="loom-frame__inside" />
      <rect x={left - 12} y={BENCH_TOP - 10} width={16} height={BENCH_BOTTOM - BENCH_TOP + 20} rx={6} className="loom-frame__post" />
      <rect x={right - 4} y={BENCH_TOP - 10} width={16} height={BENCH_BOTTOM - BENCH_TOP + 20} rx={6} className="loom-frame__post" />
      <rect x={left - 18} y={BENCH_TOP - 20} width={right - left + 36} height={14} rx={7} className="loom-frame__roller" />
    </g>
  );
}

/**
 * 平纹布面：连续的纬线打底，再把经线按"一上一下"压上去。
 *
 * 【关键：一笔画整条，不要一格一格填】把每一格画成独立的方块，无论怎么圆角都读成
 * 棋盘格 —— 因为方块的边界在四个方向上都是断的。真实的布恰好相反：经线是一条一条
 * **连续**贯穿整幅的，只是在每一梭处轮流被压住/露出来。所以画法是：
 *   1. 先铺横向的纬线带（每一行一条，贯穿整幅）；
 *   2. 再把每一根经线画成一条**贯穿整幅的竖带**，用虚线（一上一下）在纬线上开合，
 *      相邻两根相位错开半个循环。
 * 于是竖条纹是连的，横条纹也是连的，交叠处自然出现"织"的纹理 —— 和棋盘格正好
 * 在这点上相反：布有连续的经纬，棋盘没有。
 *
 * 布面与导出的成品共用这一份画法，所以屏幕上看到的和导出的不会是两种质感。
 */
function LoomWeave({
  draft,
  rows,
  left,
  top,
  width,
}: {
  draft: LoomDraft;
  rows: number;
  left: number;
  top: number;
  width: number;
}) {
  /** 一条经线占的宽度。整幅均分 12 份，与未织的裸经线一一对应。 */
  const bandWidth = width / LOOM_ENDS;
  const clothBottom = top + rows * LOOM_CELL_H;
  return (
    <g className="loom-weave">
      {/* 纬线：每一行一条贯穿整幅的横带。 */}
      {Array.from({ length: rows }, (_, row) => (
        <rect
          key={`weft${row}`}
          x={left}
          y={top + row * LOOM_CELL_H}
          width={width}
          height={LOOM_CELL_H}
          fill={rowColor(draft, row)}
        />
      ))}

      {/* 每一梭之间压出的暗痕：纬线是一行一行打紧的，这些横线就是打纬的痕迹。 */}
      {Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
        <line
          key={`pick${index}`}
          x1={left}
          y1={top + (index + 1) * LOOM_CELL_H}
          x2={left + width}
          y2={top + (index + 1) * LOOM_CELL_H}
          className="loom-weave__pick"
        />
      ))}

      {/* 经线：每根一条贯穿整幅的竖带，虚线开合出"一上一下"，相邻错开半格。 */}
      {Array.from({ length: LOOM_ENDS }, (_, end) => {
        const x = left + end * bandWidth + bandWidth / 2;
        return (
          <line
            key={`warp${end}`}
            x1={x}
            y1={top}
            x2={x}
            y2={clothBottom}
            stroke={warpColor(draft, end)}
            strokeWidth={bandWidth - 1.4}
            strokeLinecap="butt"
            strokeDasharray={`${LOOM_CELL_H} ${LOOM_CELL_H}`}
            // 奇数根错开半格 —— 这就是平纹"一上一下、隔一根错开"本身。
            strokeDashoffset={end % 2 === 0 ? 0 : LOOM_CELL_H}
            className="loom-weave__warpband"
          />
        );
      })}

      {/* 经线在光下的隆起：每根竖带中间一道极淡的高光。这是"线"与"色块"的分界。 */}
      {Array.from({ length: LOOM_ENDS }, (_, end) => (
        <line
          key={`gloss${end}`}
          x1={left + end * bandWidth + bandWidth * 0.36}
          y1={top}
          x2={left + end * bandWidth + bandWidth * 0.36}
          y2={clothBottom}
          className="loom-weave__gloss"
          strokeWidth={bandWidth * 0.16}
        />
      ))}
    </g>
  );
}

/**
 * 布面 + 经线。
 *
 * 【生长方向】布从下往上长：第 0 行贴在底梁上，新织的行压在前一行**上面**。
 * 这是立式框织机的真实情形 —— 织的人坐在下首，布在身前越织越高，没织到的经线
 * 仍然绷在布的上方通向顶梁。反过来画（布堆在顶梁、裸线垂在下面）虽然也自洽，
 * 但看起来像布"吊"在半空、线"散"在下方，不像一台机子。
 *
 * 【经线必须是同一批】未织的裸经线和织进布里的经纱是同一根线 —— 所以两处用同一个
 * 宽度（一格一根、同色）。分开画（裸线一批、布里另一批）会在织口处对不上，
 * 看着像两块不同的东西接在一起。
 *
 * 抬起的那一组经线略亮：这是梭口的缝，玩家从起伏就能看出该往哪边送梭。
 */
function LoomCloth({ draft }: { draft: LoomDraft }) {
  const rows = currentRow(draft);
  const lifted = shedGroup(draft);
  /** 第 row 行的上沿。第 0 行在最下面，序号越大越靠上。 */
  const rowY = (row: number) => CLOTH_BOTTOM - (row + 1) * LOOM_CELL_H;
  /** 织好之后布的上沿 —— 裸经线到此为止。 */
  const fellY = rows > 0 ? rowY(rows - 1) : CLOTH_BOTTOM;
  return (
    <g className="loom-cloth">
      {/* 未织的经线：12 根宽条，从织口一直绷到顶梁。与布面的格子同宽同色，织口处接得上。 */}
      {Array.from({ length: LOOM_ENDS }, (_, end) => {
        const x = LOOM_CLOTH_LEFT + end * LOOM_CELL_W + LOOM_CELL_W / 2;
        // 梭口：按经线奇偶分组，隔一根抬起一根。
        const isLifted = end % 2 === lifted;
        return (
          <line
            key={`bare${end}`}
            x1={x}
            y1={LOOM_CLOTH_TOP}
            x2={x}
            y2={fellY}
            stroke={warpColor(draft, end)}
            strokeWidth={LOOM_CELL_W - 1.2}
            strokeLinecap="butt"
            className={`loom-warp${isLifted ? ' is-lifted' : ''}`}
          />
        );
      })}

      {/* 织进去的部分：按纱的密度画平纹，不是按格子填色。 */}
      {rows > 0 ? (
        <LoomWeave
          draft={draft}
          rows={rows}
          left={LOOM_CLOTH_LEFT}
          top={rowY(rows - 1)}
          width={LOOM_CLOTH_WIDTH}
        />
      ) : null}

      {/* 打纬的细缝：压紧过的布在行与行之间有一条暗痕。 */}
      {Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
        <line
          key={`seam${index}`}
          x1={LOOM_CLOTH_LEFT}
          y1={rowY(index)}
          x2={LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH}
          y2={rowY(index)}
          className="loom-cloth__seam"
        />
      ))}

      {/* 织口：已织好的布与未织经线之间的那条线，是整台机子上唯一"活"的位置。 */}
      {rows > 0 ? (
        <line
          x1={LOOM_CLOTH_LEFT}
          y1={rowY(rows - 1)}
          x2={LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH}
          y2={rowY(rows - 1)}
          className="loom-cloth__fell"
        />
      ) : null}

      {/* 正在投的那一趟：一条还没压紧的纬线，从起点铺到梭子现在的位置。 */}
      {draft.progress > 0 && rows < LOOM_MAX_ROWS ? <LoomInProgress draft={draft} /> : null}
    </g>
  );
}

/** 走到一半的纬线。比织好的行淡一点 —— 它还没被压紧。 */
function LoomInProgress({ draft }: { draft: LoomDraft }) {
  const row = currentRow(draft);
  const direction = passDirection(draft);
  const span = LOOM_CLOTH_WIDTH * draft.progress;
  const x = direction === 1 ? LOOM_CLOTH_LEFT : LOOM_CLOTH_LEFT + LOOM_CLOTH_WIDTH - span;
  // 这一趟织的是第 row 行，也就是压在前一行上面的那一条（见 LoomCloth 的生长方向）。
  const y = CLOTH_BOTTOM - (row + 1) * LOOM_CELL_H + LOOM_CELL_H * 0.13;
  return (
    <rect
      x={x}
      y={y}
      width={span}
      height={LOOM_CELL_H * 0.74}
      fill={weftColor(draft)}
      opacity={0.6}
      className="loom-cloth__pass"
    />
  );
}

/** 梭子。位置由 progress 反推，所以它和布面上那根纬线的末端永远对齐。 */
function LoomShuttle({ draft }: { draft: LoomDraft }) {
  const row = currentRow(draft);
  const direction = passDirection(draft);
  const t = direction === 1 ? draft.progress : 1 - draft.progress;
  const x = LOOM_CLOTH_LEFT + t * LOOM_CLOTH_WIDTH;
  const y = CLOTH_BOTTOM - (row + 1) * LOOM_CELL_H + LOOM_CELL_H / 2;
  return (
    <g className="loom-shuttle" transform={`translate(${x} ${y})`}>
      <ellipse cx={1} cy={3} rx={SHUTTLE_W * 0.5} ry={SHUTTLE_W * 0.24} className="loom-shuttle__shadow" />
      <rect
        x={-SHUTTLE_W / 2}
        y={-SHUTTLE_W * 0.26}
        width={SHUTTLE_W}
        height={SHUTTLE_W * 0.52}
        rx={SHUTTLE_W * 0.26}
        className="loom-shuttle__body"
      />
      {/* 梭子中间缠着的线：就是这一趟正在织进去的颜色。 */}
      <rect
        x={-SHUTTLE_W * 0.32}
        y={-SHUTTLE_W * 0.14}
        width={SHUTTLE_W * 0.64}
        height={SHUTTLE_W * 0.28}
        rx={SHUTTLE_W * 0.14}
        fill={weftColor(draft)}
      />
    </g>
  );
}

/**
 * 成品：收边后（或织了至少一行）在台面下方给出的实物图，也是导出的来源。
 * 流苏是下机之后才有的 —— 每根经线两端各留一截散线。
 */
function LoomArtifact({ draft, artifactRef }: { draft: LoomDraft; artifactRef: React.RefObject<SVGSVGElement | null> }) {
  const { width, x, y, fringe } = artifactGeometry(draft.rows.length);
  const height = y + draft.rows.length * LOOM_CELL_H + fringe;
  return (
    <div className="loom-artifact">
      <svg
        ref={artifactRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="织好的布"
        preserveAspectRatio="xMidYMid meet"
      >
        {Array.from({ length: LOOM_ENDS }, (_, end) => {
          const cx = x + end * LOOM_CELL_W + LOOM_CELL_W / 2;
          const color = warpColor(draft, end);
          return (
            <g key={`fringe${end}`}>
              <line x1={cx} y1={y - fringe} x2={cx} y2={y} stroke={color} strokeWidth={3.2} />
              <line x1={cx} y1={y + draft.rows.length * LOOM_CELL_H} x2={cx} y2={y + draft.rows.length * LOOM_CELL_H + fringe} stroke={color} strokeWidth={3.2} />
            </g>
          );
        })}
        {/* 成品与屏幕上的布面共用同一份画法：导出的质感不会和看到的不一样。 */}
        {draft.rows.length > 0 ? (
          <LoomWeave draft={draft} rows={draft.rows.length} left={x} top={y} width={LOOM_CLOTH_WIDTH} />
        ) : null}
      </svg>
      <p className="craft-note">
        {draft.finished ? '这块布已经收边，可以导出。' : '继续织，成品会跟着长。'}
      </p>
    </div>
  );
}
