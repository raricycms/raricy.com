// 小小织布机的纯逻辑：经纬、梭口、一次「过梭」的进度与反悔都在这里。
// 零 DOM / 零 React —— tests/unit/craft-loom.test.ts 直接 import 这一份。
//
// 【为什么没有「穿完这一行」「压紧这一行」两个函数】旧版把一次投梭拆成两步、
// 各由一颗按钮触发。玩家每织一行要按两次，手上刚建立起来的往复节奏就被打断两次 ——
// 这是「出戏」的最大来源。现在一次连续拖动就是一行：走到对岸的同时自动压紧并换梭口
// （见 dragWeft），引擎里根本没有「织完了但还没压紧」这种中间状态。

export const LOOM_ENDS = 12;
export const LOOM_MAX_ROWS = 15;
export const LOOM_CELL_W = 32;
export const LOOM_CELL_H = 24;
export const LOOM_CLOTH_LEFT = 168;
export const LOOM_CLOTH_TOP = 92;
export const LOOM_CLOTH_WIDTH = LOOM_ENDS * LOOM_CELL_W;
export const LOOM_CLOTH_HEIGHT = LOOM_MAX_ROWS * LOOM_CELL_H;

/** 往回拽多远才算「反悔上一行」。太灵敏会误吃正常投梭的手抖，太大又拽不动。 */
export const LOOM_UNDO_PULL = 0.14;

export interface WarpScheme {
  id: string;
  name: string;
  /** 十二根经线各自的颜色。整块布上同一根经线从第一行到最后一行都是这个色。 */
  colors: readonly string[];
}

function warpFrom(pattern: readonly string[]): readonly string[] {
  return Array.from({ length: LOOM_ENDS }, (_, i) => pattern[i % pattern.length]);
}

/**
 * 经线配色是「上机之前就定好的」，织的过程中不再改 —— 真实织布机上经线一旦绷好，
 * 想换色就得重新上机。所以它只有四套方案可选，不参与逐行换色。
 */
export const WARP_SCHEMES: readonly WarpScheme[] = [
  { id: 'oat', name: '燕麦', colors: warpFrom(['#e5d8bf', '#d3c0a0', '#ece2cc', '#c9b691']) },
  { id: 'indigo', name: '靛青', colors: warpFrom(['#33506e', '#4a6b8a', '#d6cfbe', '#2b425c']) },
  { id: 'berry', name: '野莓', colors: warpFrom(['#9d4f55', '#c88682', '#ecdccd', '#8a4147']) },
  { id: 'moss', name: '苔原', colors: warpFrom(['#5c7259', '#8d9a76', '#b8bd9b', '#495c47']) },
] as const;

export interface WeftColor { name: string; hex: string }
export const WEFT_COLORS: readonly WeftColor[] = [
  { name: '米白', hex: '#efe6d4' },
  { name: '靛蓝', hex: '#3f6288' },
  { name: '茜红', hex: '#a8473f' },
  { name: '姜黄', hex: '#cba23e' },
  { name: '松绿', hex: '#4d7a62' },
  { name: '紫藤', hex: '#7b6999' },
  { name: '墨灰', hex: '#3b3d46' },
  { name: '天青', hex: '#7ba6b4' },
] as const;

export interface LoomRow {
  /** 这一行纬线的颜色下标。存下标而不是十六进制 —— 换线轴只影响之后的投梭。 */
  color: number;
  /** 这一行是从左往右投的还是从右往左。打结时两端要各留一截线头。 */
  direction: 1 | -1;
}

export interface LoomDraft {
  version: 2;
  warp: string;
  weft: number;
  rows: LoomRow[];
  /** 当前这一趟走过的比例 0–1。到 1 就自动成行并归零。 */
  progress: number;
  finished: boolean;
}

export const LOOM_SAVE_KEY = 'craft-loom-v2';

export function freshLoomDraft(): LoomDraft {
  return { version: 2, warp: WARP_SCHEMES[0].id, weft: 0, rows: [], progress: 0, finished: false };
}

export function warpScheme(id: string): WarpScheme {
  return WARP_SCHEMES.find((scheme) => scheme.id === id) ?? WARP_SCHEMES[0];
}

/** 第 end 根经线在这一整块布上的颜色 —— 与行号无关，所以纵向条纹是真的连续的。 */
export function warpColor(draft: LoomDraft, end: number): string {
  const colors = warpScheme(draft.warp).colors;
  return colors[((end % colors.length) + colors.length) % colors.length];
}

export function rowColor(draft: LoomDraft, row: number): string {
  const entry = draft.rows[row];
  return WEFT_COLORS[entry?.color ?? 0]?.hex ?? WEFT_COLORS[0].hex;
}

export function weftColor(draft: LoomDraft): string {
  return WEFT_COLORS[draft.weft]?.hex ?? WEFT_COLORS[0].hex;
}

/** 已经在织第几行（0 起）：行数就是下一行的下标。 */
export function currentRow(draft: LoomDraft): number {
  return draft.rows.length;
}

/** 当前这一趟的投梭方向：偶数行从左往右，奇数行从右往左。 */
export function passDirection(draft: LoomDraft): 1 | -1 {
  return draft.rows.length % 2 === 0 ? 1 : -1;
}

/**
 * 当前梭口抬起哪一组经线。每投完一趟就换组，这是平纹的两个梭口在交替。
 * 归到 draft 上算，而不是存一份独立状态 —— 少一个可能对不上的字段。
 */
export function shedGroup(draft: LoomDraft): 0 | 1 {
  return (draft.rows.length % 2) as 0 | 1;
}

/** 平纹：某一行某一列的正面是经线还是纬线。 */
export function cellFace(row: number, end: number): 'warp' | 'weft' {
  return (row + end) % 2 === 0 ? 'warp' : 'weft';
}

/** 这一根经线在这一行是不是被抬起（抬起的经线盖住纬线，正面露经）。 */
export function endLifted(draft: LoomDraft, row: number, end: number): boolean {
  return cellFace(row, end) === 'warp';
}

export function isFull(draft: LoomDraft): boolean {
  return draft.rows.length >= LOOM_MAX_ROWS;
}

export function canWeave(draft: LoomDraft): boolean {
  return !draft.finished && !isFull(draft);
}

export function setWarp(draft: LoomDraft, warp: string): LoomDraft {
  // 织过的布不能换经线：那等于把织好的布拆了重上机。
  if (draft.rows.length > 0 || draft.progress > 0) return draft;
  return { ...draft, warp: warpScheme(warp).id };
}

/** 换线轴：只改「梭子里现在穿什么线」，已经织进布里的行一律不动。 */
export function setWeft(draft: LoomDraft, weft: number): LoomDraft {
  if (!Number.isInteger(weft) || weft < 0 || weft >= WEFT_COLORS.length) return draft;
  return { ...draft, weft };
}

/**
 * 投梭。travel 是这一次拖动走过的比例：
 *
 * - `0 ≤ travel < 1`：梭子停在这里（松手不算完成，可以接着拖）。
 * - `travel ≥ 1`：到对岸 —— 这一行立刻织进布面，梭口换组，梭子回到另一侧起点。
 *   换梭口与压紧都在这一瞬间发生，没有中间状态可点。
 * - `travel < -LOOM_UNDO_PULL`：反悔。刚织进去的那一行被拽回来、梭子退回本趟起点。
 *   方向和新梭口都会跟着退回，于是「拽回来」和「投过去」是同一个动作的两个方向。
 *
 * 负得不够多（`-LOOM_UNDO_PULL < travel < 0`）什么都不做 —— 这道死区是给手抖留的。
 */
export function dragWeft(draft: LoomDraft, travel: number): LoomDraft {
  if (draft.finished) return draft;
  if (!Number.isFinite(travel)) return draft;

  if (travel < 0) {
    if (travel > -LOOM_UNDO_PULL) return draft;
    if (draft.rows.length === 0) return { ...draft, progress: 0 };
    return { ...draft, rows: draft.rows.slice(0, -1), progress: 0 };
  }

  if (travel >= 1) {
    if (!canWeave(draft)) return { ...draft, progress: 0 };
    return {
      ...draft,
      rows: [...draft.rows, { color: draft.weft, direction: passDirection(draft) }],
      progress: 0,
    };
  }

  // 布织满了就停在原地，别把梭子推到对岸之外。
  if (!canWeave(draft)) return { ...draft, progress: 0 };
  return { ...draft, progress: travel };
}

/** 只把梭子拨回本趟起点，不动已经织好的行（「这一趟投歪了」）。 */
export function resetPass(draft: LoomDraft): LoomDraft {
  return draft.progress === 0 ? draft : { ...draft, progress: 0 };
}

export function undoLoom(draft: LoomDraft): LoomDraft {
  if (draft.finished) return { ...draft, finished: false };
  if (draft.progress > 0) return { ...draft, progress: 0 };
  if (draft.rows.length === 0) return draft;
  return { ...draft, rows: draft.rows.slice(0, -1) };
}

export function finishLoom(draft: LoomDraft): LoomDraft {
  if (draft.rows.length === 0) return draft;
  return { ...draft, finished: true, progress: 0 };
}

export function resumeLoom(draft: LoomDraft): LoomDraft {
  return { ...draft, finished: false };
}

export function clearLoom(draft: LoomDraft): LoomDraft {
  // 换经线色重新开始，但保留当前的梭线选择 —— 玩家通常想接着用同一个颜色。
  return { ...freshLoomDraft(), warp: draft.warp, weft: draft.weft };
}

function validColor(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < WEFT_COLORS.length;
}

export function parseLoomDraft(raw: string | null): LoomDraft | null {
  if (!raw || raw.length > 400_000) return null;
  try {
    const data = JSON.parse(raw) as Partial<LoomDraft> | null;
    if (!data || data.version !== 2) return null;
    const warp = WARP_SCHEMES.some((scheme) => scheme.id === data.warp) ? data.warp! : WARP_SCHEMES[0].id;
    const rows = Array.isArray(data.rows)
      ? data.rows
          .slice(0, LOOM_MAX_ROWS)
          .filter((row): row is LoomRow => !!row && validColor((row as LoomRow).color))
          // 方向不从草稿里读回：它完全由行号决定，写进草稿只会有对不上的风险。
          .map((row, index) => ({ color: row.color, direction: (index % 2 === 0 ? 1 : -1) as 1 | -1 }))
      : [];
    const weft = validColor(data.weft) ? data.weft : 0;
    const progress = typeof data.progress === 'number' && Number.isFinite(data.progress)
      ? Math.max(0, Math.min(1, data.progress))
      : 0;
    const finished = data.finished === true && rows.length > 0;
    return {
      version: 2,
      warp,
      weft,
      rows,
      progress: finished ? 0 : progress,
      finished,
    };
  } catch {
    return null;
  }
}

export interface ArtifactGeometry { width: number; height: number; x: number; y: number; fringe: number }
/** 成品与屏幕上的结果图共用同一份几何，导出的形状不会和看到的不一样。 */
export function artifactGeometry(rows: number): ArtifactGeometry {
  const fringe = 30;
  const x = 64;
  const y = 56 + fringe;
  const height = y + Math.max(1, rows) * LOOM_CELL_H + fringe + 56;
  return { width: LOOM_CLOTH_WIDTH + x * 2, height, x, y, fringe };
}

/** 梭子在布面上的横坐标（0 = 左端起点，1 = 右端终点），按当前趟的方向换算。 */
export function shuttleX(draft: LoomDraft): number {
  const t = passDirection(draft) === 1 ? draft.progress : 1 - draft.progress;
  return LOOM_CLOTH_LEFT + t * LOOM_CLOTH_WIDTH;
}
