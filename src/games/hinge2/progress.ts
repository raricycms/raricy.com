import { replay, type Action } from './engine';
import { LEVELS, levelById } from './levels';

export const SAVE_KEY = 'hinge-demo-v2';
/** 存档结构版本。与初版（hinge）对齐：没有版本字段的存档无法迁移，只能整份丢弃。 */
export const PROGRESS_VERSION = 1;
/** 单关动作上限。写入端不设限，读档端超限即丢 —— 两版共用同一个常量名便于对账。 */
export const MAX_RUN_ACTIONS = 2000;
export type Progress = { version: number; selected: string; runs: Record<string, Action[]> };
export const freshProgress = (): Progress => ({ version: PROGRESS_VERSION, selected: LEVELS[0].id, runs: {} });

function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return (a.type === 'walk' && typeof a.to === 'string') || (a.type === 'turn' && (a.amount === 1 || a.amount === -1)) || a.type === 'mirror' || a.type === 'fold';
}
export function readProgress(raw: string | null): Progress {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || typeof data !== 'object' || !data.runs || typeof data.runs !== 'object') return freshProgress();
    // 老存档没有 version：照收（不能因为加了个字段就把玩家的进度清空）；
    // 只有明确写成别的版本才丢弃。
    if (data.version !== undefined && data.version !== PROGRESS_VERSION) return freshProgress();
    const result: Progress = { version: PROGRESS_VERSION, selected: levelById(data.selected).id, runs: {} };
    for (const level of LEVELS) {
      const run = data.runs[level.id];
      if (Array.isArray(run) && run.length <= MAX_RUN_ACTIONS && run.every(validAction) && replay(level, run)) result.runs[level.id] = run;
    }
    return result;
  } catch { return freshProgress(); }
}
