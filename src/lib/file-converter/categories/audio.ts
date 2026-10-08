// STUB —— 实施 agent 将整体替换本文件。
// 契约：export const CATEGORY: CategoryDef（见 ../types.ts）。
import type { CategoryDef } from '../types';

export const CATEGORY: CategoryDef = {
  key: 'audio' as CategoryDef['key'],
  label: 'audio',
  hint: '',
  accept: '',
  maxFilesPerTask: 1,
  edges: [],
};
