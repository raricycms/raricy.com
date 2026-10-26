import { replay, type Action } from './engine';
import { LEVELS, levelById } from './levels';

export const SAVE_KEY = 'hinge-demo-v3';
export type Progress = { selected: string; runs: Record<string, Action[]> };
export const freshProgress = (): Progress => ({ selected: LEVELS[0].id, runs: {} });
function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return action.type === 'press' || action.type === 'unfold' || action.type === 'flip' || (action.type === 'fold' && typeof action.crease === 'string');
}
export function readProgress(raw: string | null): Progress {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || typeof data !== 'object' || !data.runs || typeof data.runs !== 'object') return freshProgress();
    const result: Progress = { selected: levelById(data.selected).id, runs: {} };
    for (const level of LEVELS) {
      const run = data.runs[level.id];
      if (Array.isArray(run) && run.length <= 1000 && run.every(validAction) && replay(level, run)) result.runs[level.id] = run;
    }
    return result;
  } catch { return freshProgress(); }
}
