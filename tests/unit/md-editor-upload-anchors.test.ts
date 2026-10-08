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
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
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
    effects: settleUploadSlot.of({ batchId, key: `${batchId}:${index}` }),
  }).state;
}

/** 用户在等待期间改正文（打字 / 删除 / 撤销全走这一条）。 */
function edit(state: EditorState, from: number, to: number, insert: string): EditorState {
  return state.update({ changes: { from, to, insert } }).state;
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
      effects: settleUploadSlot.of({ batchId: 1, key: '1:1', message: '太大了' }),
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

// ─────────────────────────────────────────────────────────────────────────────
// 已完成槽位的区间要**随编辑映射**（不是记住当时的长度）
//
// 【为什么这一组必须单独存在】纯「乱序完成」测不出这件事：没有编辑时，
// 「当时插了几个字符」与「那段正文现在有多长」恰好相等，两版实现一模一样。
// 只有**插完第一张之后再改它**才分得出：固定长度那一版会把第二张插进第一张的
// alt / URL 里（`![LONGCAP![B](/b)TIONA](/a)`），而页面上没有任何异常 ——
// 用户看到的是图片裂开或者正文里多出一串奇怪的方括号。
// ─────────────────────────────────────────────────────────────────────────────
describe('已插入的槽位随编辑映射', () => {
  it('★ 把第一张的 alt 改长：第二张仍落在它**后面**，不钻进第一张的语法里 ★', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A', 'B']);
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('HEAD\n![A](/a)\nTAIL');

    // 用户在 `![A` 与 `]` 之间打字，把 alt 补成 LONGCAPTIONA
    state = edit(state, 7, 7, 'LONGCAPTION');

    // ★ 第二张必须落在第一张那一段**之后** ★
    // 旧实现（按「当时插了 10 个字符」累加）在这里把 B 插进 alt 中间，得到
    // `HEAD\n![LONGCAPT![B](/b)\nIONA](/a)\nTAIL` —— 正文没报错，图却没了。
    state = insertResult(state, 1, 1, '![B](/b)\n');
    expect(state.doc.toString()).toBe('HEAD\n![LONGCAPTIONA](/a)\n![B](/b)\nTAIL');
  });

  it('★ 把第一张删短（选中半张删掉）：第二张跟着前移，仍然在它后面 ★', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['A', 'B']);
    state = insertResult(state, 1, 0, '![LONGCAPTIONA](/a)\n');
    expect(state.doc.toString()).toBe('![LONGCAPTIONA](/a)\n');

    // 用户把 alt 里那 11 个字符删掉（`![` 之后到 `A` 之前）
    state = edit(state, 2, 13, '');
    expect(state.doc.toString()).toBe('![A](/a)\n');

    state = insertResult(state, 1, 1, '![B](/b)\n');
    expect(state.doc.toString()).toBe('![A](/a)\n![B](/b)\n');
  });

  it('整张已插入的图被删掉：区间塌成一点，第二张落在它原来的位置', () => {
    let state = EditorState.create({ doc: 'XY', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 1, ['A', 'B']);
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('X![A](/a)\nY');

    // 用户把第一张整段删掉（连同它那个换行）
    state = edit(state, 1, 10, '');

    state = insertResult(state, 1, 1, '![B](/b)\n');
    expect(state.doc.toString()).toBe('X![B](/b)\nY');
  });

  it('★ 删掉一段再「撤销」回来（改动形状与撤销一致）：第二张仍落在第一张后面 ★', () => {
    // 撤销产生的就是「把删掉的那几个字符原样插回去」这一条改动，所以这里直接
    // 用同样的改动形状验映射（真 undo 命令那一路在 e2e 里另有覆盖）。
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['A', 'B']);
    state = insertResult(state, 1, 0, '![LONGCAPTIONA](/a)\n');

    state = edit(state, 2, 13, '');
    expect(state.doc.toString()).toBe('![A](/a)\n');
    state = edit(state, 2, 2, 'LONGCAPTION'); // ← 撤销那一下
    expect(state.doc.toString()).toBe('![LONGCAPTIONA](/a)\n');

    state = insertResult(state, 1, 1, '![B](/b)\n');
    expect(state.doc.toString()).toBe('![LONGCAPTIONA](/a)\n![B](/b)\n');
  });

  it('乱序完成 + 中途编辑：版面顺序仍是选择顺序，且编辑留在原处', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A', 'B', 'C']);
    // 2 号先到
    state = insertResult(state, 1, 2, '![c](/c)\n');
    // 用户改 2 号那段里的一处（alt）
    state = edit(state, 7, 8, 'CC');
    // 0 号、1 号随后到 —— 仍然要排在 2 号**前面**
    state = insertResult(state, 1, 0, '![a](/a)\n');
    state = insertResult(state, 1, 1, '![b](/b)\n');
    expect(state.doc.toString()).toBe('HEAD\n![a](/a)\n![b](/b)\n![CC](/c)\nTAIL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 锚点被删除 → 整批退场，迟到的结果不许重新写回正文
//
// 【判据是「左右两个邻居都没了」】只删一侧不算（见 upload-anchors.ts 的
// isAnchorGone）：把锚点右边那段删掉、光标停在文末时放弃上传是误伤；
// 而全选删除时锚点恰好在删除区间的**边界**上，边界判据又一个都抓不到。
// ─────────────────────────────────────────────────────────────────────────────
describe('锚点被删除', () => {
  /** 锚点在中间 + 全选删除（审查报告里那一条的最小复现）。 */
  it('★ 全选删除正文之后，迟到的图片不许重新写回空正文 ★', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A']);
    state = edit(state, 0, state.doc.length, '');

    // 批次已经退场：既取不到插入点，也读不到这个批次
    expect(batchInsertPos(state, 1, 0)).toBeNull();
    expect(findBatch(state, 1)).toBeUndefined();

    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString(), '迟到的结果把图写回了刚被清空的正文').toBe('');
  });

  it('★ 锚点在文档起点、全选删除：同样退场（起点这个边界最容易漏）★', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['A']);
    state = edit(state, 0, state.doc.length, '');

    expect(batchInsertPos(state, 1, 0)).toBeNull();
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('');
  });

  it('锚点落在被删掉的那一段中间：退场', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A']);
    state = edit(state, 3, 8, ''); // 删掉 `D` `\n` `TAI`（锚点左右两个字符都在里面）

    expect(batchInsertPos(state, 1, 0)).toBeNull();
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('HEAL');
  });

  it('只删掉锚点**一侧**的文字：锚点还在，照旧插在那儿（不误伤）', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A']);
    state = edit(state, 5, 9, ''); // 只删右侧的 TAIL

    expect(batchInsertPos(state, 1, 0)).toBe(5);
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('HEAD\n![A](/a)\n');
  });

  it('正常打字不误伤：锚点还在，图照旧插在当初那个位置', () => {
    let state = EditorState.create({ doc: 'AB', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 1, ['A']);
    state = edit(state, 0, 0, 'XX');
    state = edit(state, 4, 4, 'YY');

    expect(batchInsertPos(state, 1, 0)).toBe(3);
    state = insertResult(state, 1, 0, '<img>');
    expect(state.doc.toString()).toBe('XXA<img>BYY');
  });

  it('空文档里开始的上传不误伤：用户先打了字，图仍然插在锚点（他当初的光标）处', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['A']);
    state = edit(state, 0, 0, '先打的字');
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('![A](/a)\n先打的字');
  });

  it('★ 退场的批次不会被撤销带回来（正文恢复之后图也不会自己长出来）★', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A']);
    state = edit(state, 0, state.doc.length, '');
    // 撤销那一下：正文原样回来（改动形状同 undo）
    state = edit(state, 0, 0, 'HEAD\nTAIL');

    expect(findBatch(state, 1), '退场的批次又活了').toBeUndefined();
    state = insertResult(state, 1, 0, '![A](/a)\n');
    expect(state.doc.toString()).toBe('HEAD\nTAIL');
  });

  it('一个批次退场不影响另一个批次（各按各的锚点走）', () => {
    let state = EditorState.create({ doc: 'HEAD\nTAIL', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 5, ['A']);
    state = startBatch(state, 2, 9, ['B']);
    // 删掉左半段（1 号的锚点在删除区间里，2 号的锚点在文末、只丢了一侧的邻居）
    state = edit(state, 0, 6, '');

    expect(findBatch(state, 1)).toBeUndefined();
    expect(batchInsertPos(state, 2, 0)).toBe(3);
    state = insertResult(state, 2, 0, '![B](/b)\n');
    expect(state.doc.toString()).toBe('AIL![B](/b)\n');
  });

  it('用户自己取消（点 ×）与锚点被删走同一条退场路径', () => {
    let state = EditorState.create({ doc: 'abc', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 1, ['A']);
    state = state.update({ effects: cancelUploadBatch.of(1) }).state;
    expect(batchInsertPos(state, 1, 0)).toBeNull();
    expect(findBatch(state, 1)).toBeUndefined();
  });
});

describe('边界', () => {
  it('同一位置的两个批次互不干扰', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a']);
    state = startBatch(state, 2, 0, ['b']);
    state = insertResult(state, 2, 0, '<b>');
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('<a><b>');
  });

  it('批次起点会被夹到文档范围内（锚点本身是空的、两端都没有字符时不算被删）', () => {
    let state = EditorState.create({ doc: '', extensions: [uploadBatchField] });
    state = startBatch(state, 1, 0, ['a']);
    // 空文档里没有任何可删的东西 —— 插入不是删除，锚点不动
    state = edit(state, 0, 0, 'x');
    expect(batchInsertPos(state, 1, 0)).toBe(0);
    state = insertResult(state, 1, 0, '<a>');
    expect(state.doc.toString()).toBe('<a>x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 已完成槽位被**整段删除**后再恢复：真 undo / redo / 粘贴
//
// 【为什么这一组必须存在】整张图删掉后，槽位区间塌成一点 —— 与「还没完成的
// pending 点」在数值上完全一样。若两种点按同一方向映射，撤销把正文插回这一点时
// 这个点原地不动，后到的第二张就插到了**恢复回来的第一张前面**：版面顺序与选择
// 顺序相反，且不报任何错、不留日志。判据必须是 `status`（见 upload-anchors.ts 的
// mapSlot），光看 `from === to` 分不出来。
//
// 【为什么必须用真 undo，不许手写两条改动复刻】「删掉几个字符 + 把它们原样插回」
// 确实就是撤销在正文上的形状，但**手写它只证明我们喂对了改动**；真 `undo` 走的是
// history 自己的映射，才能证明区间是**随事务映射**出来的而不是被喂出来的。
// 顺手配 `isolateHistory`：不隔离时 undo 会把「插 A + 删 A」并成一组，一按
// Ctrl+Z 连插入 A 也一起撤掉，测的就成了「回到上传前」。
// ─────────────────────────────────────────────────────────────────────────────
describe('已完成槽位被整段删除后再恢复', () => {
  const A = '![A](/a)\n';
  const B = '![B](/b)\n';

  /**
   * 真 view 桩：命令（undo / redo）只用 `state` 与 `dispatch`，而 CM6 的状态层
   * 与 DOM 无关 —— 同 md-editor-commands.test.ts 的 harness（那边有更长的理由）。
   * 与文件顶部那个纯 `EditorState` 辅助函数并列：这一组要跑**命令**，改动必须落进
   * history，所以得有 view。
   */
  function viewHarness(doc: string, cursor: number) {
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [history(), uploadBatchField],
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(...input: TransactionSpec[]) {
        for (const spec of input) state = state.update(spec).state;
      },
    } as unknown as EditorView;
    /** 组件里的那一步（取插入点 → 插入正文 → 结算），但落在真 view 上。 */
    function insert(index: number, text: string): number | null {
      const at = batchInsertPos(view.state, 1, index);
      if (at === null) return null;
      view.dispatch({
        changes: { from: at, insert: text },
        effects: settleUploadSlot.of({ batchId: 1, key: `1:${index}` }),
      });
      return at;
    }
    return { view, insert, text: () => view.state.doc.toString() };
  }

  /** 建批次 `[A, B]` → 完成 A → **隔离地**整段删掉 A（好让 undo 只撤这一组）。 */
  function deletedA() {
    const h = viewHarness('HEAD\nTAIL', 5);
    h.view.dispatch({ effects: addUploadBatch.of({ id: 1, pos: 5, names: ['A', 'B'] }) });
    h.insert(0, A);
    expect(h.text()).toBe(`HEAD\n${A}TAIL`);
    h.view.dispatch({ annotations: isolateHistory.of('before') });
    h.view.dispatch({
      changes: { from: 5, to: 5 + A.length, insert: '' },
      annotations: isolateHistory.of('after'),
    });
    expect(h.text()).toBe('HEAD\nTAIL');
    return h;
  }

  it('★ 真 undo 恢复整张图：第二张仍落在它**后面**，不许插到前面 ★', () => {
    const h = deletedA();
    expect(undo(h.view)).toBe(true);
    expect(h.text()).toBe(`HEAD\n${A}TAIL`);
    // 区间重新张开：这一槽的插入点被推到恢复回来的那段**之后**
    expect(batchInsertPos(h.view.state, 1, 1)).toBe(5 + A.length);
    h.insert(1, B);
    expect(h.text(), '恢复回来的 A 与被插到它前面的 B 换了顺序').toBe(`HEAD\n${A}${B}TAIL`);
  });

  it('★ 真 redo 再删一次：A 没了，第二张落在它原来的位置（不空占）★', () => {
    const h = deletedA();
    undo(h.view);
    expect(redo(h.view)).toBe(true);
    expect(h.text()).toBe('HEAD\nTAIL');
    h.insert(1, B);
    expect(h.text()).toBe(`HEAD\n${B}TAIL`);
  });

  it('★ 反复撤销 / 重做之后，第二张的落位仍然正确 ★', () => {
    const h = deletedA();
    undo(h.view);
    redo(h.view);
    undo(h.view);
    h.insert(1, B);
    expect(h.text()).toBe(`HEAD\n${A}${B}TAIL`);
  });

  it('★ 剪切（删）再粘贴（原样插回）恢复：形状同撤销，落位也一样 ★', () => {
    const h = viewHarness('HEAD\nTAIL', 5);
    h.view.dispatch({ effects: addUploadBatch.of({ id: 1, pos: 5, names: ['A', 'B'] }) });
    h.insert(0, A);
    h.view.dispatch({ changes: { from: 5, to: 5 + A.length, insert: '' } });
    h.view.dispatch({ changes: { from: 5, insert: A } });
    h.insert(1, B);
    expect(h.text()).toBe(`HEAD\n${A}${B}TAIL`);
  });

  it('★ 完整删除且**不恢复**：第二张落在原位置（既有行为不能丢）★', () => {
    const h = viewHarness('HEAD\nTAIL', 5);
    h.view.dispatch({ effects: addUploadBatch.of({ id: 1, pos: 5, names: ['A', 'B'] }) });
    h.insert(0, A);
    h.view.dispatch({ changes: { from: 5, to: 5 + A.length, insert: '' } });
    h.insert(1, B);
    expect(h.text()).toBe(`HEAD\n${B}TAIL`);
  });

  it('★ 乱序完成 + 已删又恢复：版面仍是选择顺序 ★', () => {
    const h = viewHarness('HEAD\nTAIL', 5);
    h.view.dispatch({ effects: addUploadBatch.of({ id: 1, pos: 5, names: ['A', 'B', 'C'] }) });
    h.insert(0, A);
    h.view.dispatch({ annotations: isolateHistory.of('before') });
    h.view.dispatch({
      changes: { from: 5, to: 5 + A.length, insert: '' },
      annotations: isolateHistory.of('after'),
    });
    undo(h.view);
    h.insert(2, '![C](/c)\n'); // 2 先到
    h.insert(1, B); // 1 后到
    expect(h.text()).toBe(`HEAD\n${A}${B}![C](/c)\nTAIL`);
  });

  it('另一个批次各按各的锚点走（谁被删、谁恢复互不影响）', () => {
    const h = viewHarness('HEAD\nTAIL', 5);
    h.view.dispatch({ effects: addUploadBatch.of({ id: 1, pos: 5, names: ['A'] }) });
    h.view.dispatch({ effects: addUploadBatch.of({ id: 2, pos: 5, names: ['B'] }) });
    h.insert(0, A); // 1 号先落
    h.view.dispatch({ changes: { from: 5, to: 5 + A.length, insert: '' } }); // 1 号的图被删
    const at = batchInsertPos(h.view.state, 2, 0);
    expect(at).toBe(5);
    h.view.dispatch({
      changes: { from: at!, insert: B },
      effects: settleUploadSlot.of({ batchId: 2, key: '2:0' }),
    });
    expect(h.text()).toBe(`HEAD\n${B}TAIL`);
  });
});
