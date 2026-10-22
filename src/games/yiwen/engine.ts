/** 图形语言的纯内核。空格与纸张尺寸也属于图案，任何操作都不裁掉空白。
 * 框把同一操作分别作用到每个格子；demo 只实现一层框，不隐式增加新规则。
 */
export type Cell = 0 | 1 | 2 | 3 | 4 | null; // ↑ → ↓ ← ● 空白
export interface Figure { readonly width: number; readonly height: number; readonly cells: readonly Cell[] }
export interface Instruction { readonly rune: 'turn' | 'copy'; readonly framed: boolean }
export const MAX_SIDE = 8;
export const MAX_PROGRAM = 8;

const SYMBOLS: Record<string, Cell> = { '^': 0, '>': 1, v: 2, '<': 3, o: 4, '.': null };
export function figure(...rows: string[]): Figure {
  const width = rows[0]?.length ?? 0;
  if (!width || width > MAX_SIDE || rows.length > MAX_SIDE || rows.some((r) => r.length !== width || [...r].some((c) => !(c in SYMBOLS)))) {
    throw new Error('Invalid Yiwen figure');
  }
  return { width, height: rows.length, cells: rows.flatMap((r) => [...r].map((c) => SYMBOLS[c])) };
}
const turnCell = (cell: Cell): Cell => cell === null || cell === 4 ? cell : ((cell + 1) % 4) as Cell;

export function apply(input: Figure, instruction: Instruction): Figure | null {
  const { width, height, cells } = input;
  if (instruction.rune === 'turn') {
    if (instruction.framed) return { width, height, cells: cells.map(turnCell) };
    const result: Cell[] = Array(cells.length).fill(null);
    cells.forEach((cell, i) => {
      const x = i % width, y = Math.floor(i / width);
      result[x * height + height - 1 - y] = turnCell(cell);
    });
    return { width: height, height: width, cells: result };
  }
  if (width * 2 > MAX_SIDE) return null;
  const result: Cell[] = [];
  for (let y = 0; y < height; y++) {
    const row = cells.slice(y * width, (y + 1) * width);
    result.push(...(instruction.framed ? row.flatMap((cell) => [cell, cell]) : [...row, ...row]));
  }
  return { width: width * 2, height, cells: result };
}

export function run(input: Figure, program: readonly Instruction[]): { frames: Figure[]; error: string | null } {
  const frames = [input];
  if (program.length > MAX_PROGRAM) return { frames, error: `一句最多放 ${MAX_PROGRAM} 枚符号。` };
  for (const instruction of program) {
    const next = apply(frames[frames.length - 1], instruction);
    if (!next) return { frames, error: `这一步超出了 ${MAX_SIDE} × ${MAX_SIDE} 的纸张。试试调整句子。` };
    frames.push(next);
  }
  return { frames, error: null };
}

export function equal(a: Figure, b: Figure): boolean {
  return a.width === b.width && a.height === b.height && a.cells.every((cell, i) => cell === b.cells[i]);
}

export function describe(input: Figure): string {
  const names = ['上箭头', '右箭头', '下箭头', '左箭头', '圆点'];
  return `${input.height} 行 ${input.width} 列：` + Array.from({ length: input.height }, (_, y) =>
    input.cells.slice(y * input.width, (y + 1) * input.width).map((cell) => cell === null ? '空白' : names[cell]).join('、')
  ).join('；');
}
