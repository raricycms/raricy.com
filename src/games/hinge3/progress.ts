import { replay, type Action } from './engine';
import { LEVELS, levelById } from './levels';

export const SAVE_KEY = 'hinge-demo-v3';
/** 存档结构版本。与初版（hinge）对齐：没有版本字段的存档无法迁移，只能整份丢弃。 */
export const PROGRESS_VERSION = 1;
/** 单关动作上限。读档端超限即丢。 */
export const MAX_RUN_ACTIONS = 1000;
export type Progress = { version: number; selected: string; runs: Record<string, Action[]> };
export const freshProgress = (): Progress => ({ version: PROGRESS_VERSION, selected: LEVELS[0].id, runs: {} });
function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return action.type === 'press' || action.type === 'unfold' || action.type === 'flip' || (action.type === 'fold' && typeof action.crease === 'string');
}
export function readProgress(raw: string | null): Progress {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || typeof data !== 'object' || !data.runs || typeof data.runs !== 'object') return freshProgress();
    // 老存档没有 version：照收；只有明确写成别的版本才丢。
    if (data.version !== undefined && data.version !== PROGRESS_VERSION) return freshProgress();
    const result: Progress = { version: PROGRESS_VERSION, selected: levelById(data.selected).id, runs: {} };
    for (const level of LEVELS) {
      const run = data.runs[level.id];
      if (Array.isArray(run) && run.length <= MAX_RUN_ACTIONS && run.every(validAction) && replay(level, run)) result.runs[level.id] = run;
    }
    return result;
  } catch { return freshProgress(); }
}
