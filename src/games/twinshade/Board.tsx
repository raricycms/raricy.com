'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Board.tsx — 双影的棋盘渲染层（纯展示，不持有任何游戏状态）
//
// 【为什么整块棋盘只有一个 <svg>】
// 一次操作要让两个身体与若干石块「同时」动，位移必须走 CSS transition；用 DOM 拼 div
// 再逐格绝对定位，节点数是格子数的几倍，而且手机 / 桌面共用一块棋盘时只能靠 media
// query 重算像素。一个 viewBox 里的 SVG 天然按比例缩放，所有坐标只跟「格」有关。
//
// 【为什么用行内 style.transform 而不是 transform 属性】
// SVG 的 transform 属性只在属性值变化时直接重绘，**不参与 CSS 过渡**；只有 CSS 的
// transform 才能被 transition 插值。所以「身体 / 石块在哪一格」写进 style.transform，
// 时长按这一笔是否滑行现算（滑行越远越慢，玩家才跟得上拖尾）。
//
// 【颜色分两半】
// 台面、地形、灯、石块面、身体光晕这些「一种角色一个颜色」的填充全部留给
// _twinshade.scss（它用 `:not([fill])` / `:not([stroke])` 兜底，见那份文件头部）；
// 本文件只写 scss **不可能知道**的按数据取色的部分：同纹组号 → 色板（组色）、
// 两个身体各自的暖/冷（core / ring / 拖尾 / 提示箭头）、以及两色交替的粒子。
// 这些用 presentation attribute 而不是类名，因为组号与 a/b 是数据，不是样式状态；
// CSS 若要接管，写一条 fill / stroke 规则即可盖掉（属性优先级最低）。
//
// 【动画参数与 scss 的接口】
// 位移时长本文件直接写在 style.transitionDuration 上；同时给身体补一个
// `--tw-token-ms`（scss 的 `.tw-token` 用 var 写 transition），两边取值同源。
// 粒子飞散方向写成 `--tw-spark-dx/dy`，scss 的 tw-spark-fly 拿它当位移终点。
//
// 【坐标约定】
// CELL = 100：关卡都很小（十几格），100 单位的格子让手写偏移量（半径、箭头、菱形）
// 都是好读的两位整数，缩放后也够清晰。真正的像素尺寸交给 CSS（svg 宽度 100%）。
//
// 【健壮性】
// 这个组件直接吃关卡与状态数据，任何一处坏值（越界下标 / 缺字段）都不该让整块棋盘
// 抛异常：所有取坐标都过 clampCell()，尺寸、地形、石块、同纹组全部按「可能为空」处理。
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { TERRAIN } from './types';
import type { Dir } from './types';
import type { BoardProps } from './ui-types';

// ── 布局常量 ────────────────────────────────────────────────────────────────

/** 一格的逻辑边长（viewBox 单位）。改它会让下面所有几何常量按比例失效，别单独改。 */
const CELL = 100;
/** 每格四周留的缝：让网格自己显形，不依赖 scss 再画一遍格子线。 */
const CELL_GAP = 3;
/** 石块面片的边长（占格 74%），四周留出空隙，两块石头贴在一起时也分得清。 */
const BLOCK = CELL * 0.74;
/** 防御性尺寸上限：坏数据给出 10^9 宽的关卡时，不要让 viewBox 与循环一起失控。 */
const MAX_SIDE = 64;

/** 两个身体的固定顺序：a = 本体（暖），b = 影子（冷）。 */
const TOKEN_SIDES = ['a', 'b'] as const;

/** hintDir → 箭头旋转角度。箭头在 SVG 里画成「朝上」，所以 up 是 0°。 */
const HINT_ROTATION: Readonly<Record<Dir, number>> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};

/**
 * 同纹组号（1–9）→ 固定色板。同组两块石头拿同一个颜色，玩家扫一眼就知道「这俩一伙」。
 * 9 个颜色刻意在色相上拉开，深色棋盘上彼此可辨；组号越界时取模兜底，不抛异常。
 */
const GROUP_COLORS = [
  // 顺序有意义：**组号 1 是最常用的**（现在的关卡里同纹组都叫 1），所以它必须与
  // 两个身体的颜色（暖金 #FFC861 / 冷紫 #A78BFA）拉开距离 —— 否则「这块石头」
  // 与「本体」在深色台面上会读混。所以暖金与紫被挪到了 8、9 位。
  '#6FD3A8', // 1 薄荷
  '#6FB6FF', // 2 天蓝
  '#FF8F8F', // 3 珊瑚
  '#7FE0D4', // 4 青
  '#F2A0D8', // 5 粉
  '#F2E06B', // 6 柠檬
  '#A8D46B', // 7 黄绿
  '#F2B33D', // 8 琥珀
  '#8C9EFF', // 9 蓝紫
] as const;

/**
 * 普通石块中心的圆点。scss 里 `.tw-block__mark` 是 `fill: none` 的**描边**标记
 * （见 _twinshade.scss），所以这里画成闭合圆路径而不是实心点，填色交给 CSS 取消。
 */
const PLAIN_MARK = 'M 0 -7 A 7 7 0 1 1 0 7 A 7 7 0 1 1 0 -7 Z';

/**
 * 同纹石块的 ◈ 标记：外菱形 + 内菱形两条闭合子路径。描边后读作「空心菱形环」，
 * 与普通石块的圆点在形状上第一眼就能分开；颜色由数据取（组号 → 色板）。
 */
const LINKED_MARK = 'M 0 -21 L 21 0 L 0 21 L -21 0 Z M 0 -9 L 9 0 L 0 9 L -9 0 Z';

/** 提示箭头：尖端在上（-0.62 格），底部两翼收在 -0.39 格，中央留缺口形成箭头。 */
const AIM_PATH = `M 0 ${-CELL * 0.62} L ${CELL * 0.15} ${-CELL * 0.39} L 0 ${-CELL * 0.46} L ${-CELL * 0.15} ${-CELL * 0.39} Z`;

/**
 * 通关火花：12 个固定方向（角度 / 离两身体中点的格数 / 半径比例），全部硬编码。
 * **刻意不用 Math.random** —— 火花位置参与渲染结构，随机会让 SSR 与 CSR 对不上，
 * 也会让「每次通关的花火长得不一样」；这里要的是每次都一样的一次性动画。
 * 同一张表既给「初始散开的小圈」，也给飞散向量（scss 的 tw-spark-fly 读 --tw-spark-dx/dy）。
 */
const SPARK_SPECS: readonly { readonly angle: number; readonly dist: number; readonly size: number }[] = [
  { angle: 8, dist: 0.68, size: 0.032 },
  { angle: 34, dist: 1.02, size: 0.022 },
  { angle: 63, dist: 0.74, size: 0.042 },
  { angle: 96, dist: 0.92, size: 0.026 },
  { angle: 124, dist: 0.6, size: 0.034 },
  { angle: 157, dist: 0.98, size: 0.02 },
  { angle: 188, dist: 0.72, size: 0.04 },
  { angle: 214, dist: 1.05, size: 0.024 },
  { angle: 243, dist: 0.64, size: 0.03 },
  { angle: 272, dist: 0.9, size: 0.044 },
  { angle: 305, dist: 0.7, size: 0.022 },
  { angle: 332, dist: 0.95, size: 0.034 },
];

// ── 小工具（都是纯函数，放组件外面避免每次渲染重建）────────────────────────

/** 关卡边长兜底：非数字 / 非正 / 超大一律夹回 [1, MAX_SIDE]。 */
function clampSide(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_SIDE, Math.max(1, Math.trunc(value)));
}

/** 线性下标 → 格坐标；越界就夹到棋盘内，绝不返回 NaN（越界下标也只是画在边角）。 */
function clampCell(index: unknown, width: number, height: number): { x: number; y: number } {
  const total = width * height;
  let cell = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0;
  if (cell < 0) cell = 0;
  if (cell >= total) cell = total - 1;
  return { x: cell % width, y: Math.floor(cell / width) };
}

/** 线性下标 → 该格中心的 SVG 坐标。身体、石块、灯、拖尾共用这一套换算。 */
function cellCenter(index: unknown, width: number, height: number): { x: number; y: number; cx: number; cy: number } {
  const { x, y } = clampCell(index, width, height);
  return { x, y, cx: x * CELL + CELL / 2, cy: y * CELL + CELL / 2 };
}

/** 同纹组号 → 色板颜色（组号缺失 / 越界时落到第 1 色）。 */
function groupColor(group: unknown): string {
  const raw = typeof group === 'number' && Number.isFinite(group) ? Math.trunc(Math.abs(group)) : 1;
  return GROUP_COLORS[(Math.max(1, raw) - 1) % GROUP_COLORS.length];
}

/** 非法方向值在运行时会从 data 里漏进来，读不到角度就退回「朝上」，避免整条 transform 失效。 */
function rotationFor(dir: Dir | null): number {
  return dir !== null && dir in HINT_ROTATION ? HINT_ROTATION[dir] : 0;
}

/** events.trail 理论上一定是数组；这里再兜一层，容器传坏值时只是不画拖尾。 */
function asCellList(value: unknown): readonly number[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 是否偏好减少动效。**只能在挂载后的 effect 里读**（window 不存在于 SSR），
 * 首帧一律按「能动」渲染，客户端拿到真实值后再把时长归零 —— 由此不会出现水合错位。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    // 老 Safari 只有 addListener；监听失败也不影响首帧判断，所以两条路都兜着。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', sync);
      return () => query.removeEventListener('change', sync);
    }
    query.addListener(sync);
    return () => query.removeListener(sync);
  }, []);

  return reduced;
}

// ── 组件 ────────────────────────────────────────────────────────────────────

export default function Board({ level, state, events, serial, hintDir, blocked, solved }: BoardProps) {
  const reducedMotion = usePrefersReducedMotion();

  const width = clampSide(level?.width);
  const height = clampSide(level?.height);
  const total = width * height;

  const levelId = typeof level?.id === 'string' ? level.id : '';
  const levelName = typeof level?.name === 'string' && level.name.trim() ? level.name.trim() : '关卡';

  // 下面这些都用「可能为空」的写法取：渲染层不该假设引擎永远给的是完整形状。
  const terrain = Array.isArray(level?.terrain) ? level.terrain : [];
  const goals = level?.goals instanceof Set ? level.goals : null;
  const blocks = Array.isArray(level?.blocks) ? level.blocks : [];
  const groups = level?.groups instanceof Map ? level.groups : null;
  const groupIds = Array.isArray(level?.groupIds) ? level.groupIds : [];
  const blockCells = Array.isArray(state?.blocks) ? state.blocks : [];

  const aPos = cellCenter(state?.a, width, height);
  const bPos = cellCenter(state?.b, width, height);
  const midX = (aPos.cx + bPos.cx) / 2;
  const midY = (aPos.cy + bPos.cy) / 2;

  // 位移时长：普通一步 170ms；滑行 n 格 = 170 + 55n（走得越远越慢，拖尾才跟得上）。
  // 没有 events（刚进关 / 撤销 / 重置 / 换关）就 0ms：那几种情况棋盘是「瞬移」的，
  // 让身体从上一关的位置滑到新位置反而像卡顿。减少动效时一律 0ms。
  const slideOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const durationA = !events || reducedMotion ? 0 : 170 + 55 * slideOf(events?.selves?.a?.slide);
  const durationB = !events || reducedMotion ? 0 : 170 + 55 * slideOf(events?.selves?.b?.slide);
  // 石块被推的那一下跟着「这一笔里最慢的那个身体」走：两边同时停下才像一次动作。
  const blockDuration = Math.max(durationA, durationB);

  const movementStyle = (cx: number, cy: number, duration: number): CSSProperties => ({
    transform: `translate(${cx}px, ${cy}px)`,
    transitionProperty: 'transform',
    transitionDuration: `${duration}ms`,
  });

  // 身体额外补一个 `--tw-token-ms`：_twinshade.scss 的 `.tw-token` 用它写 transition，
  // 时长与上面的行内 transitionDuration 同源 —— 两份都写只是为了任一侧被改动时数值不漂。
  const tokenStyle = (cx: number, cy: number, duration: number): CSSProperties =>
    ({
      ...movementStyle(cx, cy, duration),
      '--tw-token-ms': `${duration}ms`,
    }) as CSSProperties;

  // 灯：只渲染落在棋盘内的目标格（坏数据里越界的灯直接跳过，别把它挤到边角上）。
  const goalCells: number[] = [];
  if (goals) {
    for (const cell of goals) {
      if (typeof cell === 'number' && Number.isFinite(cell) && cell >= 0 && cell < total) goalCells.push(cell);
    }
    goalCells.sort((left, right) => left - right);
  }

  // 石块位置：state.blocks 按 CompiledLevel.blocks 的下标对齐；缺项退回出生格。
  const blockLayout: { id: number; group: number | null; x: number; y: number; cx: number; cy: number }[] = [];
  blocks.forEach((spec, order) => {
    if (!spec || typeof spec !== 'object') return;
    const id = Number.isFinite(spec?.id) ? spec.id : order;
    const stored = blockCells[id];
    const cell = Number.isFinite(stored) ? stored : spec?.cell;
    const group = spec?.group !== null && spec?.group !== undefined && Number.isFinite(spec.group) ? spec.group : null;
    const position = cellCenter(cell, width, height);
    blockLayout.push({ id, group, x: position.x, y: position.y, cx: position.cx, cy: position.cy });
  });

  // 同纹连线：按 groupIds 的顺序把同组石块两两连起来（渲染在石块之前，压在下面）。
  // 用「当前所在格」而不是出生格 —— 石头被推动后线要跟着走，否则联动关系会瞬间说谎。
  const layoutById = new Map<number, { cx: number; cy: number }>();
  for (const block of blockLayout) layoutById.set(block.id, block);

  const links: { key: string; x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
  if (groups) {
    for (const groupId of groupIds) {
      const members = groups.get(groupId);
      if (!Array.isArray(members) || members.length < 2) continue;
      const color = groupColor(groupId);
      for (let index = 0; index + 1 < members.length; index += 1) {
        const from = layoutById.get(members[index]);
        const to = layoutById.get(members[index + 1]);
        if (!from || !to) continue;
        links.push({ key: `${groupId}-${index}`, x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy, color });
      }
    }
  }

  return (
    <svg
      className="tw-board"
      viewBox={`0 0 ${width * CELL} ${height * CELL}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`双影棋盘：${levelName}`}
      data-level-id={levelId}
      data-solved={solved ? 'true' : 'false'}
    >
      <title>{`双影棋盘：${levelName}`}</title>

      {/* 只剩一个滤镜：光晕靠高斯模糊把边缘揉开，比画十几圈同心圆便宜，也不会在缩放时露齿。
          id 以 tw- 开头（契约），避免和页面里别的内联 SVG 撞名。 */}
      <defs>
        <filter id="tw-glow-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* 台面底色由 .tw-board-wrap 的渐变提供；这里只留一块透明垫底，让 scss 的配色透上来。 */}
      <rect
        className="tw-board__bg"
        x={0}
        y={0}
        width={width * CELL}
        height={height * CELL}
      />

      {/* 地形层：每格一个 rect；冰面额外叠一层 sheen（低透明度高光）。
          颜色全部交给 scss（--tw-floor / --tw-wall-2 / --tw-ice-2），这里只管几何。 */}
      <g className="tw-cells">
        {Array.from({ length: total }, (_, index) => {
          const x = index % width;
          const y = Math.floor(index / width);
          const terrainValue = terrain[index];
          const isWall = terrainValue === TERRAIN.wall;
          const isIce = terrainValue === TERRAIN.ice;
          const onGoal = goals !== null && goals.has(index);
          const classes = ['tw-cell'];
          if (isWall) classes.push('tw-cell--wall');
          // 最外圈那圈墙只是「几何边界」，不是可交互的墙：把它压暗，棋盘才有一圈干净的
          // 画框；真正需要看清的是**内部**的墙（它们决定这一步能不能走）。
          if (isWall && (x === 0 || y === 0 || x === width - 1 || y === height - 1)) {
            classes.push('tw-cell--edge');
          }
          if (isIce) classes.push('tw-cell--ice');
          // 灯下面那格也标出来：让「目标」同时落在格子与灯圈两层，亮起来时整格一起亮。
          if (onGoal) classes.push('tw-cell--goal');
          const px = x * CELL + CELL_GAP;
          const py = y * CELL + CELL_GAP;
          const size = CELL - CELL_GAP * 2;
          return (
            <Fragment key={index}>
              <rect
                className={classes.join(' ')}
                data-cell={`${x},${y}`}
                x={px}
                y={py}
                width={size}
                height={size}
                rx={12}
              />
              {isIce && (
                <rect
                  className="tw-ice-sheen"
                  x={px}
                  y={py}
                  width={size}
                  height={size}
                  rx={12}
                />
              )}
            </Fragment>
          );
        })}
      </g>

      {/* 灯：细环在前、光晕在后（按契约的兄弟顺序）。点亮状态靠 `tw-goal--lit` 类，
          具体怎么亮（描边透明度 / 光晕呼吸）由 scss 决定；这里只负责给出这个类。 */}
      <g className="tw-goals">
        {goalCells.map((cell) => {
          const position = cellCenter(cell, width, height);
          return (
            <g
              key={cell}
              className={solved ? 'tw-goal tw-goal--lit' : 'tw-goal'}
              data-cell={`${position.x},${position.y}`}
            >
              <circle
                className="tw-goal-ring"
                cx={position.cx}
                cy={position.cy}
                r={CELL * 0.24}
              />
              <circle
                className="tw-goal-halo"
                cx={position.cx}
                cy={position.cy}
                r={CELL * 0.42}
              />
            </g>
          );
        })}
      </g>

      {/* 拖尾：key 挂 serial，原地重复同一步时坐标一模一样，只有换 key 才能重播动画。 */}
      <g className="tw-trails" key={`trails-${serial}`}>
        {events
          ? TOKEN_SIDES.flatMap((side) => {
              const cells = asCellList(events?.trail?.[side]).slice(0, total);
              return cells.map((cell, index) => {
                const position = cellCenter(cell, width, height);
                // 起点几乎看不见、末端最亮：拖尾是「刚才从哪儿来」的余像，不能抢身体的注意力。
                const head = cells.length > 1 ? index / (cells.length - 1) : 1;
                return (
                  <circle
                    key={`${side}-${index}`}
                    className="tw-trail"
                    cx={position.cx}
                    cy={position.cy}
                    r={10 + 9 * head}
                    fill={side === 'a' ? '#FFC861' : '#A78BFA'}
                    style={{
                      opacity: 0.1 + 0.4 * head,
                      animationDelay: `${index * 28}ms`,
                    }}
                  />
                );
              });
            })
          : null}
      </g>

      {/* 石块层：先连线（同纹组的两块之间），再画石块本体。 */}
      <g className="tw-blocks">
        {links.map((link) => (
          // 虚线 / 低透明度 / 线宽都在 scss 里定；这里只给「哪一组」的颜色。
          <line
            key={link.key}
            className="tw-link-line"
            x1={link.x1}
            y1={link.y1}
            x2={link.x2}
            y2={link.y2}
            stroke={link.color}
          />
        ))}
        {blockLayout.map((block) => {
          const linked = block.group !== null;
          // 同纹石块的颜色是数据（组号）决定的，scss 无从知道，所以由 Board 写进 stroke；
          // 普通石块不写，让 scss 的白色描边兜底。
          const color = groupColor(block.group ?? 1);
          return (
            <g
              key={block.id}
              className={linked ? 'tw-block tw-block--linked' : 'tw-block'}
              data-block={block.id}
              data-cell={`${block.x},${block.y}`}
              style={movementStyle(block.cx, block.cy, blockDuration)}
            >
              <rect
                className="tw-block__face"
                x={-BLOCK / 2}
                y={-BLOCK / 2}
                width={BLOCK}
                height={BLOCK}
                rx={16}
                stroke={linked ? color : undefined}
              />
              {/* scss 里 `.tw-block__mark` 是 fill:none 的描边标记，所以 mark 用描边画：
                  普通块 = 圆点轮廓，同纹块 = 双菱形（◈）轮廓，组色由 stroke 给。 */}
              <path
                className="tw-block__mark"
                d={linked ? LINKED_MARK : PLAIN_MARK}
                fill="none"
                stroke={linked ? color : undefined}
              />
            </g>
          );
        })}
      </g>

      {/* 两个身体：暖金 = 本体（实线细环），冷紫 = 影子（虚线环）。
          core 是浅色实心，ring / 光晕取 --tw-body / --tw-shade 的同一个值；
          scss 负责描边粗细与过渡曲线，这里负责「a 是暖的、b 是冷的」这件事。 */}
      <g className="tw-tokens">
        {TOKEN_SIDES.map((side) => {
          const position = side === 'a' ? aPos : bPos;
          const duration = side === 'a' ? durationA : durationB;
          const isBlocked = Boolean(blocked?.[side]);
          const warm = side === 'a';
          const classes = ['tw-token', `tw-token--${side}`];
          // 类名只改颜色 / 抖动；位移始终在 style.transform 上，切换类名不会丢位置。
          if (isBlocked) classes.push('tw-token--blocked');
          return (
            <g
              key={side}
              className={classes.join(' ')}
              data-token={side}
              style={tokenStyle(position.cx, position.cy, duration)}
            >
              <circle
                className="tw-token__glow"
                r={CELL * 0.47}
                filter="url(#tw-glow-blur)"
                // 通关时把光晕提亮（scss 的 fill 是半透明软色，这里只调整体不透明度）。
                opacity={solved ? 1 : 0.65}
              />
              <circle className="tw-token__core" r={CELL * 0.27} fill={warm ? '#FFF4D6' : '#F1EBFF'} />
              <circle
                className="tw-token__ring"
                r={CELL * 0.35}
                fill="none"
                stroke={warm ? '#FFC861' : '#A78BFA'}
                strokeDasharray={warm ? undefined : '7 8'}
              />
            </g>
          );
        })}
      </g>

      {/* 提示箭头：定位与旋转放在**无类名的外层 g**（静态 transform 属性），
          .tw-aim 只当 scss 脉冲动画的壳 —— 如果 scss 的 keyframes 动 transform，
          它只会让箭头在原地颤，不会把箭头从身体上甩到 (0,0)。 */}
      <g className="tw-aims">
        {hintDir
          ? TOKEN_SIDES.map((side) => {
              const position = side === 'a' ? aPos : bPos;
              const angle = rotationFor(hintDir);
              return (
                // key 里带 hintDir 但不带 serial：每次提示（方向可能相同）重新挂载一次，
                // 脉冲从头播；走路 / 撤销不会白白重启它。
                <g
                  key={`${side}-${hintDir}`}
                  transform={`translate(${position.cx} ${position.cy}) rotate(${angle})`}
                >
                  <g className="tw-aim">
                    <path d={AIM_PATH} fill={side === 'a' ? '#FFD98A' : '#C3B0FF'} />
                  </g>
                </g>
              );
            })
          : null}
      </g>

      {/* 通关火花：从两身体中点向外散开。位置与飞散向量都来自上面的固定角度表，
          scss 的 tw-spark-fly 读 --tw-spark-dx/dy 当位移终点。减少动效时整组不渲染。 */}
      <g className="tw-sparks" key={`sparks-${serial}`}>
        {solved && !reducedMotion
          ? SPARK_SPECS.map((spark, index) => {
              const radians = (spark.angle * Math.PI) / 180;
              const reach = spark.dist * CELL;
              // 起点只到半程、终点再飞出一段：先是一圈小光点，再向外散开淡出。
              const cx = midX + Math.cos(radians) * reach * 0.5;
              const cy = midY + Math.sin(radians) * reach * 0.5;
              const style = {
                animationDelay: `${index * 40}ms`,
                // SVG 里 scale 的默认原点在 (0,0)，不改成自身中心的话粒子会边缩边往角落跑。
                transformBox: 'fill-box',
                transformOrigin: 'center',
                '--tw-spark-dx': `${Math.cos(radians) * reach * 0.9}px`,
                '--tw-spark-dy': `${Math.sin(radians) * reach * 0.9}px`,
              } as CSSProperties;
              return (
                <circle
                  key={index}
                  className="tw-spark"
                  cx={cx}
                  cy={cy}
                  r={spark.size * CELL}
                  fill={index % 2 === 0 ? '#FFE6A8' : '#C9B4FF'}
                  style={style}
                />
              );
            })
          : null}
      </g>
    </svg>
  );
}
