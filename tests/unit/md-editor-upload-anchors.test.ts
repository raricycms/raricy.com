// ─────────────────────────────────────────────────────────────────────────────
// md-editor-upload-anchors.test.ts —— 上传锚点的**状态机**
//
// 【为什么整组用例都在跑"完成顺序的排列"】锚点机制存在的唯一理由，就是让
// 「版面顺序 = 用户选择的顺序」与「网络完成顺序」脱钩。只测一种完成顺序等于
// 什么都没测 —— 顺序正确的那一版和恰好按序完成的那一版，行为完全一样。
// 所以每个排列都真跑一遍：三张图有 3! = 6 种完成顺序，全跑。
//
// 【不用真 EditorView】StateField / StateEffect 全在 @codemirror/state 里，
// 与 DOM 无关。用 EditorState.update() 直接推进状态，比挂 jsdom 稳得多。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  addUploadBatch,
  batchInsertPos,
  cancelUploadBatch,
  findBatch,
  settleUploadSlot,
  uploadBatchField,
} from '@/lib/md-editor/upload-anchors';

/** 组件里的那一步：取插入点 → 插入正文 → 结算槽位（同一个事务）。 */
function insertResult(state: EditorState, batchId: number, index: number, text: string): EditorState {
  const at = batchInsertPos(state, batchId, index);
  if (at === null) return state;
  return state.update({
    changes: { from: at, insert: text },
    effects: settleUploadSlot.of({ batchId, key: `${batchId}:${index}`, length: text.length }),
  }).state;
}

function startBatch(state: EditorState, id: number, pos: number, names: string[]): EditorState {
  return state.update({ effects: addUploadBatch.of({ id, pos, names }) }).state;
}

/** 全排列 —— 就 6 种，写死在这里比引一个工具函数清楚。 */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

describe('按选择顺序落位', () => {
  const LABELS = ['![a.png](/a)\n', '![b.png](/b)\n', '![c.png](/c)\n'];

  for (const order of permutations([0, 1, 2])) {
    it(`完成顺序 ${order.join('-')} → 版面仍是 0-1-2`, () => {
      let state = EditorState.create({ doc: '前后的字', extensions: [uploadBatchField] });
      // 锚点落在「的」与「字」之间（位置 3）
      state = startBatch(state, 1, 3, ['a.png', 'b.png', 'c.png']);
      for (const i of order) state = insertResult(state, 1, i, LABELS[i]);
      expect(state.doc.toString()).toBe(`前后的${LABELS.join('')}字`);
    });
  }

  it('插入的是标准 Markdown（图片语法 + 每张一个换行）', () => {
    const text = '![shot.png](/api/images/abcdefghij/raw)\n';
    let state = EditorState.create({ doc: 'X', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['shot.png']);
    state = insertResult(state, 1, 0, text);
    expect(state.doc.toString()).toBe(text + 'X');
  });
});

describe('位置随编辑映射', () => {
  it('锚点前面打字，图片仍插在原位置之前', () => {
    let state = EditorState.create({ doc: 'AB', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 1, ['a.png']); // 落在 A 与 B 之间
    // 用户在锚点**前面**（位置 0）又打了两个字
    state = state.update({ changes: { from: 0, insert: 'XX' } }).state;
    state = insertResult(state, 1, 0, '<img>');
    expect(state.doc.toString()).toBe('XXA<img>B');
  });

  it('锚点后面打字不影响插入点', () => {
    let state = EditorState.create({ doc: 'AB', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 1, ['a.png']);
    state = state.update({ changes: { from: 2, insert: 'ZZ' } }).state;
    state = insertResult(state, 1, 0, '<img>');
    expect(state.doc.toString()).toBe('A<img>BZZ');
  });
});

describe('失败与取消', () => {
  it('某一槽失败不占长度：后面的槽仍然紧挨着', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a', 'b', 'c']);
    state = state.update({
      effects: settleUploadSlot.of({ batchId: 1, key: '1:1', length: 0, message: '太大了' }),
    }).state;
    state = insertResult(state, 1, 0, '<a>');
    state = insertResult(state, 1, 2, '<c>');
    expect(state.doc.toString()).toBe('<a><c>');
    // 槽位状态：0/2 成功、1 失败
    const batch = findBatch(state, 1);
    expect(batch).toBeUndefined(); // 全部结算完 → 整批退场
  });

  it('取消整批后，迟到的结果插不进来', () => {
    let state = EditorState.create({ doc: 'D', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a', 'b']);
    state = state.update({ effects: cancelUploadBatch.of(1) }).state;
    // 批次已退场 → 取不到插入点
    expect(batchInsertPos(state, 1, 0)).toBeNull();
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('D');
  });

  it('取消只停住还没完成的部分，已插入的正文不动', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a', 'b']);
    state = insertResult(state, 1, 0, '<a>');
    state = state.update({ effects: cancelUploadBatch.of(1) }).state;
    expect(state.doc.toString()).toBe('<a>');
    expect(findBatch(state, 1)).toBeUndefined();
  });

  it('全部结算完之后，同一条结果再来一次不会重复插入', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a']);
    state = insertResult(state, 1, 0, '<a>');
    // 第二次（比如重试路径里迟到的第二份响应）
    expect(batchInsertPos(state, 1, 0)).toBeNull();
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('<a>');
  });

  it('批次退场后插入点返回 null（调用方据此放弃）', () => {
    let state = EditorState.create({ doc: 'abc', extensions: [uploadBatchField] });
    expect(batchInsertPos(state, 99, 0)).toBeNull();
    state = startBatch(state, 1, 1, ['a']);
    expect(batchInsertPos(state, 1, 0)).toBe(1);
  });
});

describe('边界', () => {
  it('批次起点会被夹到文档范围内（文档在等待期间被清空时）', () => {
    let state = EditorState.create({ doc: 'abcdef', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['a']);
    // 用户全选删掉整个文档
    state = state.update({ changes: { from: 0, to: 6, insert: '' } }).state;
    const at = batchInsertPos(state, 1, 0);
    expect(at).toBe(0);
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('<a>');
  });

  it('同一位置的两个批次互不干扰', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a']);
    state = startBatch(state, 2, 0, ['b']);
    state = insertResult(state, 2, 0, '<b>');
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('<a><b>');
  });
});
