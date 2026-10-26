import { countMirrors, emptyBoard, trace, type Level, type Mirror } from './engine';

export const STORAGE_KEY = 'raricy_lumen_v2';
export interface Progress { version: 1; current: { id: string; board: Mirror[] }; completed: string[] }
export const freshProgress = (levels: readonly Level[]): Progress => ({ version: 1, current: { id: levels[0].id, board: emptyBoard(levels[0]) }, completed: [] });

export function readProgress(raw: string | null, levels: readonly Level[]): Progress {
  const fresh = freshProgress(levels);
  try {
    const data = JSON.parse(raw ?? 'null');
    if (data?.version !== 1) return fresh;
    const completed = Array.isArray(data.completed) ? levels.flatMap((l) => data.completed.includes(l.id) ? [l.id] : []) : [];
    const level = levels.find((l) => l.id === data.current?.id);
    const board = data.current?.board;
    if (!level || !Array.isArray(board) || board.length !== level.sockets.length || board.some((v) => ![0, 1, 2].includes(v)) || countMirrors(board) > level.stock) return { ...fresh, completed };
    if (trace(level, board).solved && !completed.includes(level.id)) completed.push(level.id);
    return { version: 1, current: { id: level.id, board }, completed };
  } catch { return fresh; }
}
