// STUB —— 实施 agent 将整体替换本文件。
// 契约：export const CATEGORY: CategoryDef（见 ../types.ts）。
import type { CategoryDef } from '../types';

export const CATEGORY: CategoryDef = {
  key: 'document' as CategoryDef['key'],
  label: 'office',
  hint: '',
  accept: '',
  maxFilesPerTask: 1,
  edges: [],
};

// STUB —— office agent 追加：DOCX→EPUB 等借用 office 引擎的电子书边。
export const ebookExtraEdges: import('../types').EdgeDef[] = [];
