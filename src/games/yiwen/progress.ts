import { MAX_PROGRAM, type Instruction } from './engine';
import { EXPERIMENTS } from './levels';

export const SAVE_KEY = 'yiwen-demo-v1';
export interface Progress {
  version: 1;
  selected: string;
  drafts: Record<string, Instruction[]>;
  completed: string[];
  opened: boolean;
}
export function freshProgress(): Progress {
  return { version: 1, selected: '01', drafts: {}, completed: [], opened: false };
}
const ids = [...EXPERIMENTS.map((level) => level.id), 'plate'];
export function readProgress(raw: string | null): Progress {
  const clean = freshProgress();
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || data.version !== 1) return clean;
    if (ids.includes(data.selected)) clean.selected = data.selected;
    if (data.drafts && typeof data.drafts === 'object') {
      for (const id of ids) {
        const draft = data.drafts[id];
        if (Array.isArray(draft) && draft.length <= MAX_PROGRAM && draft.every((op) =>
          op && (op.rune === 'turn' || op.rune === 'copy') && typeof op.framed === 'boolean')) {
          clean.drafts[id] = draft.map(({ rune, framed }: Instruction) => ({ rune, framed }));
        }
      }
    }
    if (Array.isArray(data.completed)) clean.completed = EXPERIMENTS.map((e) => e.id).filter((id) => data.completed.includes(id));
    clean.opened = data.opened === true;
  } catch { /* 损坏的本地存档回到空白实验台，不影响游戏。 */ }
  return clean;
}
