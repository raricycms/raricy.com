import { isWon, replay, type Action } from './engine';
import { LEVELS, levelById } from './levels';

export const SAVE_KEY = 'hinge-demo-v3';
/** 存档结构版本。与初版（hinge）对齐：没有版本字段的存档无法迁移，只能整份丢弃。 */
export const PROGRESS_VERSION = 1;
/** 单关动作上限。读档端超限即丢。 */
export const MAX_RUN_ACTIONS = 1000;
/**
 * 存档 = 「本局步骤」+「已通关集合」两件事，**分开存**（与 hinge2 / 初版同一口径）：
 * `runs` 是每张纸当前这一局的动历史，撤销 / 重来会改它；`completed` 是通关过的纸页 id，
 * 只增不减。旧实现由历史推导完成状态，撤销一步或重开当前关卡会把标记一起抹掉。
 */
export type Progress = { version: number; selected: string; runs: Record<string, Action[]>; completed: string[] };
export const freshProgress = (): Progress => ({ version: PROGRESS_VERSION, selected: LEVELS[0].id, runs: {}, completed: [] });

/** 记一次通关：只加不删，且不碰本局步骤。重开/撤销不会调用它。 */
export function recordCompletion(progress: Progress, levelId: string): Progress {
  if (!LEVELS.some((level) => level.id === levelId) || progress.completed.includes(levelId)) return progress;
  return { ...progress, completed: [...progress.completed, levelId] };
}

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
    const result: Progress = { version: PROGRESS_VERSION, selected: levelById(data.selected).id, runs: {}, completed: [] };
    for (const level of LEVELS) {
      const run = data.runs[level.id];
      if (!Array.isArray(run) || run.length > MAX_RUN_ACTIONS || !run.every(validAction)) continue;
      const state = replay(level, run);
      if (!state) continue;
      result.runs[level.id] = run;
      // 旧存档只有 runs（完成状态由历史推导）：按「这段历史确实通关了」补回完成记录。
      if (isWon(level, state)) result.completed.push(level.id);
    }
    // 新存档的 completed 直接采纳：撤销 / 重开之后历史证明不了通关，但记录仍是事实。
    if (Array.isArray(data.completed)) {
      for (const id of data.completed) {
        if (typeof id === 'string' && LEVELS.some((level) => level.id === id) && !result.completed.includes(id)) result.completed.push(id);
      }
    }
    return result;
  } catch { return freshProgress(); }
}
