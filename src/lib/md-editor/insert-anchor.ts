// ─────────────────────────────────────────────────────────────────────────────
// md-editor/insert-anchor.ts —— 「面板打开那一刻的落点」在编辑期间的存活与映射
//
// 【为什么需要它】资源面板是**模态**的：打开时把光标位置记下来，用户挑一条、
// 确认，才把引用插回正文。这中间正文**仍然会变** —— 在飞的上传完成时会把图片
// 插进正文（那也是一次 dispatch），面板背后还可能来一次撤销。位置不跟着改动
// 走的话，插入点会落在别的地方：用户看到的是一段插错位置的引用，而代码里
// 每一行都「按当时算出来的坐标」执行得毫无异常。
//
// 【为什么不用 upload-anchors 那套零宽 widget】那套是**看得见**的：它要在正文里
// 渲染一枚「上传中」胶囊。资源面板的落点不该往正文里加任何字符或装饰 —— 面板
// 取消时正文必须**一个字符都没动过**（§4.2）。所以这里只留一个纯数字，
// 靠 CM6 的 change desc 映射。
//
// 【映射语义】改动落在锚点**正上方**时锚点往右让（`assoc: 1`）：上传刚插进来的
// 图片在锚点之前，用户挑的引用就排在它后面，与「先看到图片、再插引用」的直觉一致。
//
// 零依赖（只 import 类型），可直接单测（tests/unit/md-editor-insert-anchor.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ChangeDesc } from '@codemirror/state';

export interface InsertAnchor {
  /** 记下落点（面板打开那一刻的主选区表头）。 */
  capture(pos: number): void;
  /** 正文变了 —— 把落点按这次改动映射过去。没捕获过就什么都不做。 */
  map(changes: ChangeDesc): void;
  /** 当前落点；没捕获过（或已 clear）返回 null。 */
  get(): number | null;
  /** 面板关闭（含取消）时丢掉落点。 */
  clear(): void;
}

export function createInsertAnchor(): InsertAnchor {
  let pos: number | null = null;
  return {
    capture(next) {
      pos = next;
    },
    map(changes) {
      if (pos === null) return;
      pos = changes.mapPos(pos, 1);
    },
    get: () => pos,
    clear() {
      pos = null;
    },
  };
}
