import { replay, type Action } from './engine';
import { LEVELS } from './levels';

export const SAVE_KEY = 'hinge-demo-v1';
export interface Progress { version: 1; selected: string; runs: Record<string, Action[]>; completed: string[] }
export function freshProgress(): Progress { return { version: 1, selected: '01', runs: {}, completed: [] }; }

function isAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  if (a.type === 'walk') return Number.isInteger(a.direction) && Number(a.direction) >= 0 && Number(a.direction) < 4;
  if (typeof a.room !== 'string') return false;
  if (a.type === 'rotate') return a.amount === 1 || a.amount === -1;
  return a.type === 'slide' && Number.isInteger(a.direction) && Number(a.direction) >= 0 && Number(a.direction) < 4;
}

export function readProgress(raw: string | null): Progress {
  const result = freshProgress();
  if (!raw || raw.length > 2_000_000) return result;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1) return result;
    if (LEVELS.some((l) => l.id === data.selected)) result.selected = data.selected;
    result.completed = LEVELS.filter((l) => Array.isArray(data.completed) && data.completed.includes(l.id)).map((l) => l.id);
    for (const level of LEVELS) {
      const actions = data.runs?.[level.id];
      // 只接纳能从初始图真实重放的动作，不信任外部写入的人物位置。
      if (Array.isArray(actions) && actions.length <= 3000 && actions.every(isAction) && replay(level, actions)) result.runs[level.id] = actions;
    }
  } catch { /* 损坏的存档不阻止试玩。 */ }
  return result;
}
