import { initialRotations, isRotatable, type Level } from './engine';

export const STORAGE_KEY = 'raricy_lumen_v1';
export interface Progress {
  version: 1;
  best: Record<string, number>;
  current: { id: string; rotations: number[]; moves: number };
  sound: boolean;
}
export function freshProgress(levels: Level[]): Progress {
  return { version: 1, best: {}, current: { id: levels[0].id, rotations: initialRotations(levels[0]), moves: 0 }, sound: false };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Storage is optional and untrusted; an old/partial/broken save must never make
 * the game inaccessible. Only known levels and legal orientations survive. */
export function readProgress(raw: string | null, levels: Level[]): Progress {
  const result = freshProgress(levels);
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    if (!object(data) || data.version !== 1) return result;
    result.sound = data.sound === true;
    if (object(data.best)) for (const level of levels) {
      const best = data.best[level.id];
      if (count(best) && best >= level.par) result.best[level.id] = best;
    }
    if (object(data.current)) {
      const saved = data.current;
      const level = levels.find((l) => l.id === saved.id);
      if (level && count(saved.moves) && Array.isArray(saved.rotations) && saved.rotations.length === level.pieces.length
        && saved.rotations.every((r, i) => (r === 0 || r === 1) && (isRotatable(level.pieces[i]) || r === (level.pieces[i].rotation ?? 0)))) {
        const rotations = saved.rotations as number[];
        const distance = rotations.filter((r, i) => r !== (level.pieces[i].rotation ?? 0)).length;
        if (saved.moves >= distance) result.current = { id: level.id, rotations, moves: saved.moves };
      }
    }
  } catch { /* fall back to a fresh, playable board */ }
  return result;
}
