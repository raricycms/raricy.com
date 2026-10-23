// 小小织布机的纯逻辑：平纹格、抬经组、梭子进度与撤销都在这里，组件只负责画和接手势。
// 零 DOM / 零 React —— tests/unit/craft-loom.test.ts 直接 import 这一份。

export const LOOM_ENDS = 12;
export const LOOM_MAX_ROWS = 15;
export const LOOM_CELL_W = 32;
export const LOOM_CELL_H = 24;
export const LOOM_CLOTH_LEFT = 168;
export const LOOM_CLOTH_TOP = 92;
export const LOOM_CLOTH_WIDTH = LOOM_ENDS * LOOM_CELL_W;
export const LOOM_CLOTH_HEIGHT = LOOM_MAX_ROWS * LOOM_CELL_H;

export interface WarpScheme {
  id: string;
  name: string;
  colors: readonly string[];
}

/** 经线一共十二根，每组的排布直接写死 —— 配色是「织之前选定的经线」，不参与逐行换色。 */
export const WARP_SCHEMES: readonly WarpScheme[] = [
  { id: 'oat', name: '燕麦', colors: ['#e8dcc5', '#d9c7a7', '#e8dcc5', '#cbb892', '#e8dcc5', '#d9c7a7', '#e8dcc5', '#cbb892', '#e8dcc5', '#d9c7a7', '#e8dcc5', '#cbb892'] },
  { id: 'indigo', name: '靛青', colors: ['#304a66', '#405f7e', '#304a66', '#d9d2c2', '#304a66', '#405f7e', '#6f8aa5', '#d9d2c2', '#304a66', '#405f7e', '#304a66', '#6f8aa5'] },
  { id: 'berry', name: '野莓', colors: ['#9e4a50', '#d9a3a0', '#9e4a50', '#ead9cb', '#c4706e', '#9e4a50', '#d9a3a0', '#ead9cb', '#9e4a50', '#c4706e', '#9e4a50', '#ead9cb'] },
  { id: 'moss', name: '苔原', colors: ['#5a7058', '#8f9c77', '#5a7058', '#b9bf9c', '#718669', '#5a7058', '#8f9c77', '#b9bf9c', '#5a7058', '#718669', '#5a7058', '#b9bf9c'] },
] as const;

export interface WeftColor { name: string; hex: string }
export const WEFT_COLORS: readonly WeftColor[] = [
  { name: '米白', hex: '#efe6d4' },
  { name: '靛蓝', hex: '#3f5f86' },
  { name: '茜红', hex: '#a8473f' },
  { name: '姜黄', hex: '#cda23e' },
  { name: '松绿', hex: '#4d7a62' },
  { name: '紫藤', hex: '#7b6999' },
  { name: '墨灰', hex: '#3b3d46' },
  { name: '天青', hex: '#7ba6b4' },
] as const;

export interface LoomRow { color: number }

export interface LoomDraft {
  version: 1;
  started: boolean;
  warp: string;
  weft: number;
  rows: LoomRow[];
  progress: number;
  finished: boolean;
}

export const LOOM_SAVE_KEY = 'craft-loom-v1';

export function freshLoomDraft(): LoomDraft {
  return { version: 1, started: false, warp: WARP_SCHEMES[0].id, weft: 0, rows: [], progress: 0, finished: false };
}

export function warpScheme(id: string): WarpScheme {
  return WARP_SCHEMES.find((scheme) => scheme.id === id) ?? WARP_SCHEMES[0];
}

export function warpColor(draft: LoomDraft, end: number): string {
  const colors = warpScheme(draft.warp).colors;
  return colors[((end % colors.length) + colors.length) % colors.length];
}

export function rowColor(draft: LoomDraft, row: number): string {
  const entry = draft.rows[row];
  return WEFT_COLORS[entry?.color ?? 0]?.hex ?? WEFT_COLORS[0].hex;
}

/** 当前这一行应该抬起哪一组经线：偶数行抬起偶数号经线，奇数行抬起奇数号。 */
export function shedGroup(draft: LoomDraft): 0 | 1 {
  return (draft.rows.length % 2) as 0 | 1;
}

/** 平纹：一块格由经线还是纬线露在正面决定。 */
export function cellFace(row: number, end: number): 'warp' | 'weft' {
  return (row + end) % 2 === 0 ? 'warp' : 'weft';
}

/** 当前这一行的梭子从哪边出发：偶数行从左往右，奇数行从右往左。 */
export function passDirection(draft: LoomDraft): 1 | -1 {
  return draft.rows.length % 2 === 0 ? 1 : -1;
}

export function startLoom(draft: LoomDraft, warp: string): LoomDraft {
  return { ...draft, started: true, warp: warpScheme(warp).id, rows: [], progress: 0, finished: false };
}

export function setWeft(draft: LoomDraft, weft: number): LoomDraft {
  if (!Number.isInteger(weft) || weft < 0 || weft >= WEFT_COLORS.length) return draft;
  return { ...draft, weft };
}

export function setPassProgress(draft: LoomDraft, progress: number): LoomDraft {
  if (!draft.started || draft.finished || draft.rows.length >= LOOM_MAX_ROWS) return draft;
  const next = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return { ...draft, progress: next };
}

export function passComplete(draft: LoomDraft): boolean {
  return draft.progress >= 0.995;
}

export function canBeat(draft: LoomDraft): boolean {
  return draft.started && !draft.finished && draft.rows.length < LOOM_MAX_ROWS && passComplete(draft);
}

/** 压紧：把这一行真正织进布面，梭子回到下一行的起点。 */
export function beatRow(draft: LoomDraft): LoomDraft {
  if (!canBeat(draft)) return draft;
  return { ...draft, rows: [...draft.rows, { color: draft.weft }], progress: 0 };
}

/** 撤销：先退掉走到一半的梭子，再退上一行。 */
export function undoLoom(draft: LoomDraft): LoomDraft {
  if (draft.progress > 0) return { ...draft, progress: 0 };
  if (!draft.rows.length) return draft;
  return { ...draft, rows: draft.rows.slice(0, -1), progress: 0, finished: false };
}

export function finishLoom(draft: LoomDraft): LoomDraft {
  if (!draft.rows.length) return draft;
  return { ...draft, finished: true, progress: 0 };
}

export function resumeLoom(draft: LoomDraft): LoomDraft {
  return { ...draft, finished: false };
}

export function clearLoom(): LoomDraft {
  return freshLoomDraft();
}

function validColor(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < WEFT_COLORS.length;
}

export function parseLoomDraft(raw: string | null): LoomDraft | null {
  if (!raw || raw.length > 400_000) return null;
  try {
    const data = JSON.parse(raw) as Partial<LoomDraft> | null;
    if (!data || data.version !== 1) return null;
    const warp = WARP_SCHEMES.some((scheme) => scheme.id === data.warp) ? data.warp! : WARP_SCHEMES[0].id;
    const rows = Array.isArray(data.rows)
      ? data.rows.slice(0, LOOM_MAX_ROWS).filter((row): row is LoomRow => !!row && validColor((row as LoomRow).color)).map((row) => ({ color: row.color }))
      : [];
    const weft = validColor(data.weft) ? data.weft : 0;
    const progress = typeof data.progress === 'number' && Number.isFinite(data.progress)
      ? Math.max(0, Math.min(1, data.progress)) : 0;
    const started = data.started === true;
    const finished = data.finished === true && rows.length > 0;
    return { version: 1, started, warp, weft, rows, progress: started && !finished ? progress : 0, finished };
  } catch {
    return null;
  }
}

export interface ArtifactGeometry { width: number; height: number; x: number; y: number; fringe: number }
/** 成品（围巾/杯垫）与页面上那块结果图共用同一份几何，导出不会和屏幕上的形状漂移。 */
export function artifactGeometry(rows: number): ArtifactGeometry {
  const fringe = 30;
  const x = 64;
  const y = 56 + fringe;
  return { width: LOOM_CLOTH_WIDTH + x * 2, height: y + rows * LOOM_CELL_H + fringe + 56, x, y, fringe };
}
