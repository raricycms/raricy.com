// ─────────────────────────────────────────────────────────────────────────────
// categories/index.ts —— 八个能力区标签页的唯一组装处。
//
// 「文档 / PDF」标签页 = pdf.ts 的边 + office.ts 的边（同一 CategoryKey: document）。
// 「电子书」标签页 = ebook.ts 的边 + office.ts 导出的 ebookExtraEdges（DOCX→EPUB
// 要借 mammoth，归 office 引擎 owner）。
// ─────────────────────────────────────────────────────────────────────────────

import type { CategoryDef, EdgeDef } from '../types';
import { CATEGORY as IMAGE } from './image';
import { CATEGORY as AUDIO } from './audio';
import { CATEGORY as VIDEO } from './video';
import { CATEGORY as PDF } from './pdf';
import { CATEGORY as OFFICE, ebookExtraEdges as OFFICE_EBOOK_EDGES } from './office';
import { CATEGORY as TABLE } from './table';
import { CATEGORY as TEXT } from './text';
import { CATEGORY as EBOOK } from './ebook';
import { CATEGORY as ARCHIVE } from './archive';

function mergeDocument(pdf: CategoryDef, office: CategoryDef): CategoryDef {
  return {
    key: 'document',
    label: '文档 / PDF',
    hint:
      'PDF 页面图、图片成 PDF、文字提取、PDF 合并拆分与 OCR；DOCX 与 Markdown / HTML 互转。' +
      'PDF / 扫描件重建为可编辑文档是**近似重建**，结果页会说明保真范围。',
    accept: '.pdf,.docx,.doc,.odt,.rtf,.md,.markdown,.html,.htm,.txt',
    maxFilesPerTask: Math.max(pdf.maxFilesPerTask, office.maxFilesPerTask),
    edges: [...pdf.edges, ...office.edges],
    // ★ 两个子类别的 probe 都要保住 ★
    // 只合并 edges 的话，document 标签页永远拿不到深度探测结果（PDF 的页数、
    // DOCX 的元信息），而**症状是「够不到」而不是报错**：页数上限与 estimateOutput
    // 只能等 runner 内判，体验上从「提前拒绝」退化成「先入队再失败」。
    //
    // 两个 probe 都会被调用 —— 廉价的前提是**各自先按 sniff.kind 自判归属，
    // 不是自己的就立刻返回 {}**（这本来就是 probe 的契约：自己降级、绝不抛）。
    // 谁的 probe 忘了这条纪律，就会变成「打开每个 PDF 都顺带加载一次 mammoth」。
    probe: async (file, info) => {
      const [a, b] = await Promise.all([
        pdf.probe ? pdf.probe(file, info) : Promise.resolve({}),
        office.probe ? office.probe(file, info) : Promise.resolve({}),
      ]);
      return { ...a, ...b };
    },
  };
}

function mergeEbook(ebook: CategoryDef, extra: EdgeDef[]): CategoryDef {
  return { ...ebook, edges: [...ebook.edges, ...extra] };
}

export const CATEGORIES: CategoryDef[] = [
  IMAGE,
  AUDIO,
  VIDEO,
  mergeDocument(PDF, OFFICE),
  TABLE,
  TEXT,
  mergeEbook(EBOOK, OFFICE_EBOOK_EDGES),
  ARCHIVE,
];

export function categoryByKey(key: string): CategoryDef | null {
  return CATEGORIES.find((c) => c.key === key) ?? null;
}
