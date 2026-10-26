import { replay, type Action } from './engine';
import { LEVELS, levelById } from './levels';

export const SAVE_KEY = 'hinge-demo-v2';
export type Progress = { selected: string; runs: Record<string, Action[]> };
export const freshProgress = (): Progress => ({ selected: LEVELS[0].id, runs: {} });

function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return (a.type === 'walk' && typeof a.to === 'string') || (a.type === 'turn' && (a.amount === 1 || a.amount === -1)) || a.type === 'mirror' || a.type === 'fold';
}
export function readProgress(raw: string | null): Progress {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || typeof data !== 'object' || !data.runs || typeof data.runs !== 'object') return freshProgress();
    const result: Progress = { selected: levelById(data.selected).id, runs: {} };
    for (const level of LEVELS) {
      const run = data.runs[level.id];
      if (Array.isArray(run) && run.length <= 2000 && run.every(validAction) && replay(level, run)) result.runs[level.id] = run;
    }
    return result;
  } catch { return freshProgress(); }
}
