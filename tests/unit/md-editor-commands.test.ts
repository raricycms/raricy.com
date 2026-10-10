// ─────────────────────────────────────────────────────────────────────────────
// md-editor-commands.test.ts —— 工具条命令的纯逻辑（不挂真 EditorView）
//
// 【为什么要一个假 view】commands.ts 只用到 `view.state` 与 `view.dispatch`，
// 而 CM6 的**状态**层（@codemirror/state）与 DOM 完全无关。用一个只做
// `state = state.update(spec).state` 的桩，就能在 node 环境里把每条命令跑成
// 「输入文档 + 选区 → 输出文档 + 选区」。挂真 EditorView 反而要 jsdom 去凑
// 一堆布局 API（Range / getClientRects），测的是 jsdom 的完成度而不是命令。
//
// 【每条命令都要断选区】命令改完文档后光标落在哪，是「点了按钮接着打字」这条
// 主路径的一半。只断文本的话，多行前缀那类命令少算偏移的 bug 会全绿通过
// ——而它恰恰是最容易写错的一处（见 commands.ts 里那段长注释）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import * as cmd from '@/lib/md-editor/commands';

type Range = [number, number];

interface Harness {
  view: EditorView;
  text(): string;
  /** 全部选区（多光标时不止一个），按位置升序。 */
  ranges(): Range[];
  /** 主选区。 */
  main(): Range;
  /** 主选区在 `selection.ranges` 里的序号 —— 多光标时「哪个是主」本身就是一条断言。 */
  mainIndex(): number;
}

function harness(
  doc: string,
  ranges: Range[] = [[0, 0]],
  extra: Extension[] = [],
  // 主选区的序号。默认 0（绝大多数用例只有一个区间）；多光标用例要显式给它非 0 的
  // 值才验得出「命令有没有把主选区打回第一个」—— 见 insertLineBreak 那条。
  mainIndex = 0
): Harness {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map(([a, b]) => EditorSelection.range(a, b)),
      mainIndex
    ),
    // 必须显式开：不开的话 EditorState.create 会把多选区压成一个（asSingle()），
    // 多光标用例会「只剩第一个区间」而看不出原因。真编辑器里也开了同一条。
    extensions: [EditorState.allowMultipleSelections.of(true), ...extra],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(...input: TransactionSpec[]) {
      for (const spec of input) state = state.update(spec).state;
    },
  } as unknown as EditorView;
  return {
    view,
    text: () => view.state.doc.toString(),
    ranges: () => view.state.selection.ranges.map((r) => [r.from, r.to] as Range),
    main: () => {
      const r = view.state.selection.main;
      return [r.from, r.to];
    },
    mainIndex: () => view.state.selection.mainIndex,
  };
}

describe('toggleWrap', () => {
  it('选中文字：包上标记并选中内部', () => {
    const h = harness('hello', [[0, 5]]);
    expect(cmd.toggleWrap('**')(h.view)).toBe(true);
    expect(h.text()).toBe('**hello**');
    expect(h.main()).toEqual([2, 7]);
  });

  it('空选区：插占位符并选中它（接着打字直接替换）', () => {
    const h = harness('', [[0, 0]]);
    cmd.toggleWrap('**', '粗体')(h.view);
    expect(h.text()).toBe('**粗体**');
    expect(h.main()).toEqual([2, 4]);
  });

  it('已被标记包住时脱掉（点第二下取消）', () => {
    const h = harness('**hello**', [[2, 7]]);
    cmd.toggleWrap('**')(h.view);
    expect(h.text()).toBe('hello');
    expect(h.main()).toEqual([0, 5]);
  });

  it('单边只是一个同类标记时不脱（`*hi*` 上的 `**` 不会把 `*` 当成自己的边）', () => {
    const h = harness('*hi*', [[1, 3]]);
    cmd.toggleWrap('**')(h.view);
    expect(h.text()).toBe('***hi***');
  });

  it('多光标：每个区间各自成对', () => {
    const h = harness('a b', [
      [0, 1],
      [2, 3],
    ]);
    cmd.toggleWrap('**')(h.view);
    expect(h.text()).toBe('**a** **b**');
    expect(h.ranges()).toEqual([
      [2, 3],
      [8, 9],
    ]);
  });
});

describe('行首标记', () => {
  it('无序列表：跨三行的选区一起加，且选区跟着前面的插入一起挪', () => {
    // 选区从第 1 行中间到第 3 行
    const h = harness('aaa\nbbb\nccc', [[1, 10]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('- aaa\n- bbb\n- ccc');
    // 两端都仍在原来那几个字上：`aaa` 的第二个 a（3）、`ccc` 的最后一个 c 之前（16）。
    // 少算前面那 6 就会整体左移——这是本组用例真正要钉的东西。
    expect(h.main()).toEqual([3, 16]);
  });

  it('无序列表：光标只碰它所在的那一行，且仍停在同一段文字上', () => {
    const h = harness('aaa\nbbb\nccc', [[9, 9]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('aaa\nbbb\n- ccc');
    expect(h.main()).toEqual([11, 11]);
  });

  it('无序列表：已经是列表时整块脱掉', () => {
    const h = harness('- aaa\n- bbb', [[0, 11]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('aaa\nbbb');
  });

  it('混排（部分有标记）时一律按「加」处理', () => {
    const h = harness('- aaa\nbbb', [[0, 9]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('- - aaa\n- bbb');
  });

  it('有序列表：按行序号重新编号', () => {
    const h = harness('aa\nbb\ncc', [[0, 8]]);
    cmd.toggleOrderedList(h.view);
    expect(h.text()).toBe('1. aa\n2. bb\n3. cc');
  });

  it('有序列表：中途插入一行时后面的号码顺延（不是全卡在 1.）', () => {
    const h = harness('1. aa\ncc', [[0, 8]]);
    cmd.toggleOrderedList(h.view);
    expect(h.text()).toBe('1. 1. aa\n2. cc');
  });

  it('任务列表与引用各有自己的标记', () => {
    const a = harness('aa', [[0, 2]]);
    cmd.toggleTaskList(a.view);
    expect(a.text()).toBe('- [ ] aa');

    const b = harness('aa', [[0, 2]]);
    cmd.toggleQuote(b.view);
    expect(b.text()).toBe('> aa');
  });
});

describe('缩进', () => {
  it('增加缩进：两行为一级，光标跟着挪', () => {
    const h = harness('aa\nbb', [[0, 5]]);
    cmd.shiftIndent(false)(h.view);
    expect(h.text()).toBe('  aa\n  bb');
    expect(h.main()).toEqual([2, 9]);
  });

  it('减少缩进：按已有的一到两个空格或制表符退', () => {
    const h = harness('   aa\n\t bb', [[0, 9]]);
    cmd.shiftIndent(true)(h.view);
    expect(h.text()).toBe(' aa\n bb');
  });

  it('减少缩进：本来就没有缩进的行不动', () => {
    const h = harness('aa', [[1, 1]]);
    expect(cmd.shiftIndent(true)(h.view)).toBe(true);
    expect(h.text()).toBe('aa');
  });
});

describe('标题', () => {
  it('加二级标题（光标保持在同一段文字上）', () => {
    const h = harness('abc', [[1, 1]]);
    cmd.setHeading(2)(h.view);
    expect(h.text()).toBe('## abc');
    expect(h.main()).toEqual([4, 4]);
  });

  it('换级别时先脱掉旧的井号', () => {
    const h = harness('## abc', [[5, 5]]);
    cmd.setHeading(1)(h.view);
    expect(h.text()).toBe('# abc');
  });

  it('level 0 = 正文（脱掉井号）', () => {
    const h = harness('### abc', [[6, 6]]);
    cmd.setHeading(0)(h.view);
    expect(h.text()).toBe('abc');
  });

  it('只作用于主选区那一行 —— 多行选区不会整块变标题', () => {
    const h = harness('aa\nbb\ncc', [[0, 8]]);
    cmd.setHeading(1)(h.view);
    expect(h.text()).toBe('# aa\nbb\ncc');
  });
});

describe('行前缀命令的选区（行首 / 前缀内部）', () => {
  // 这一组钉的是「落点不能手算」——旧实现写的是 `位置 ± 前缀长度`，光标停在行首
  // 时算出负数（`0 - 2 = -2`），那一步**不报错**，要等到下一次改动才炸成
  // `RangeError: Invalid change range -2 to -2`（报错的那一下是粗体，不是它）。
  // 所以每条都跑一次后续的格式命令 —— 只断「改完的文本对不对」是抓不到的。
  it('行首点「正文」（# heading）：光标落回行首，后续粗体不抛 RangeError', () => {
    const h = harness('# heading', [[0, 0]]);
    cmd.setHeading(0)(h.view);
    expect(h.text()).toBe('heading');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
    expect(h.text()).toBe('**bold**heading');
  });

  it('光标停在前缀内部（# 之后）点「正文」：收口到行首', () => {
    const h = harness('# heading', [[2, 2]]);
    cmd.setHeading(0)(h.view);
    expect(h.text()).toBe('heading');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
  });

  it('换级别时光标停在行首（## abc 上点一级）：不落到负坐标', () => {
    const h = harness('## abc', [[0, 0]]);
    cmd.setHeading(1)(h.view);
    expect(h.text()).toBe('# abc');
    expect(h.main()[0]).toBeGreaterThanOrEqual(0);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
  });

  it('行首取消列表（- item）：光标落回行首，后续粗体不抛 RangeError', () => {
    const h = harness('- item', [[0, 0]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('item');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
    expect(h.text()).toBe('**bold**item');
  });

  it('光标停在前缀内部（- 之后）取消列表：收口到行首', () => {
    const h = harness('- item', [[1, 1]]);
    cmd.toggleBulletList(h.view);
    expect(h.text()).toBe('item');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
  });

  it('行首取消引用（> quote）：光标落回行首，后续行内代码不抛', () => {
    const h = harness('> quote', [[0, 0]]);
    cmd.toggleQuote(h.view);
    expect(h.text()).toBe('quote');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('`', 'code')(h.view)).not.toThrow();
  });

  it('行首减少缩进（两个空格）：光标落回行首，后续粗体不抛 RangeError', () => {
    const h = harness('  item', [[0, 0]]);
    cmd.shiftIndent(true)(h.view);
    expect(h.text()).toBe('item');
    expect(h.main()).toEqual([0, 0]);
    expect(() => cmd.toggleWrap('**', 'bold')(h.view)).not.toThrow();
    expect(h.text()).toBe('**bold**item');
  });

  it('光标停在正文里时仍跟着同一段文字走（不是一律甩到行首）', () => {
    // 反向护栏：修「负坐标」不能矫枉成「光标每次都跳回行首」。
    // `# heading` 下标 5 的 `d` 在脱掉 `# ` 之后应落在下标 3。
    const h = harness('# heading', [[5, 5]]);
    cmd.setHeading(0)(h.view);
    expect(h.text()).toBe('heading');
    expect(h.main()).toEqual([3, 3]);
  });
});

describe('插入类', () => {
  it('链接：选中的文字当标题，并选中标题', () => {
    const h = harness('点这里', [[0, 3]]);
    cmd.insertLink()(h.view);
    expect(h.text()).toBe('[点这里](url)');
    expect(h.main()).toEqual([1, 4]);
  });

  it('链接：没有选中文字时插占位并选中它', () => {
    const h = harness('', [[0, 0]]);
    cmd.insertLink()(h.view);
    expect(h.text()).toBe('[链接文字](url)');
    expect(h.main()).toEqual([1, 5]);
  });

  it('代码块：选中的内容原样进围栏（不缩进、不转义）', () => {
    const h = harness('a <b>', [[0, 5]]);
    cmd.insertCodeBlock()(h.view);
    expect(h.text()).toBe('```\na <b>\n```');
    expect(h.main()).toEqual([4, 9]);
  });

  it('表格：行中间插入时先补一个换行', () => {
    const h = harness('abc', [[1, 1]]);
    cmd.insertTable()(h.view);
    expect(h.text().startsWith('a\n| 列 1 | 列 2 |')).toBe(true);
  });

  it('分隔线：粘在行尾会被读成 setext 标题，所以先断行', () => {
    const h = harness('abc', [[3, 3]]);
    cmd.insertHorizontalRule()(h.view);
    expect(h.text()).toBe('abc\n---\n');
  });

  it('公式块：选中内容进 $$，并选中它', () => {
    const h = harness('a+b', [[0, 3]]);
    cmd.insertMathBlock()(h.view);
    expect(h.text()).toBe('$$\na+b\n$$\n');
    expect(h.main()).toEqual([3, 6]);
  });

  it('公式块：没有选中内容时用占位符', () => {
    const h = harness('', [[0, 0]]);
    cmd.insertMathBlock()(h.view);
    expect(h.text()).toBe('$$\nx^2\n$$\n');
  });

  it('插纯文本（表情）', () => {
    const h = harness('ab', [[1, 1]]);
    cmd.insertText('🐟')(h.view);
    expect(h.text()).toBe('a🐟b');
    expect(h.main()).toEqual([3, 3]);
  });
});

describe('单行换行（Shift+Enter）', () => {
  // 这一组钉的是「只插一个 \n」：渲染侧靠 gfm + breaks 把单个 \n 渲成一个 <br>，
  // 所以命令里**多插一个字符都是错的**（多一个 \n = 成品里多一个空行），
  // 而这也是它存在的唯一理由 —— 默认的 Enter 在列表里会续写标记、在 () [] {}
  // 之间会补第二个换行（见 commands.ts 的 insertLineBreak）。
  it('光标处只插一个换行，光标落到下一行行首', () => {
    const h = harness('ab', [[1, 1]]);
    cmd.insertLineBreak()(h.view);
    expect(h.text()).toBe('a\nb');
    expect(h.main()).toEqual([2, 2]);
  });

  it('行尾插入：不多带行尾空格、也不带任何标记', () => {
    const h = harness('- 列表项', [[4, 4]]);
    cmd.insertLineBreak()(h.view);
    // `- 列表项` 里插一个 \n 就是「列表项里换行」，不是「新建下一项」（那是 Enter 的事）
    expect(h.text()).toBe('- 列表\n项');
    expect(h.text()).not.toContain('<br>');
    expect(/[ \t]\n/.test(h.text())).toBe(false);
  });

  it('夹在 () [] {} 之间时也只插一个 —— 默认的 Enter 这里会插两个', () => {
    for (const pair of ['()', '[]', '{}']) {
      const h = harness(`a${pair[0]}${pair[1]}b`, [[2, 2]]);
      cmd.insertLineBreak()(h.view);
      expect(h.text()).toBe(`a${pair[0]}\n${pair[1]}b`);
    }
  });

  it('有选区时整体替换成一个换行', () => {
    const h = harness('abc', [[0, 3]]);
    cmd.insertLineBreak()(h.view);
    expect(h.text()).toBe('\n');
    expect(h.main()).toEqual([1, 1]);
  });

  it('多光标：每个区间各插一个，后面的区间不会因为前面的插入而错位', () => {
    // 主选区给**非 0** 的一档 —— 这条同时钉住「后面的区间不错位」与「主选区没被打回
    // 第一个」。写死 mainIndex 0 的话后者永远不会红（见 insertLineBreak 的落点注释）。
    const h = harness(
      'ab',
      [
        [0, 0],
        [2, 2],
      ],
      [],
      1
    );
    cmd.insertLineBreak()(h.view);
    expect(h.text()).toBe('\nab\n');
    // 第二条落点是**这个换行之后**（= 新那行的行首，末尾是空行时就是文末）
    expect(h.ranges()).toEqual([
      [1, 1],
      [4, 4],
    ]);
    // ★ 主选区仍是第二个区间（`insertNewlineAndIndent` 从前也是这么保持的）★
    expect(h.mainIndex()).toBe(1);
    expect(h.main()).toEqual([4, 4]);
  });

  it('多光标 + 其中一个区间有选区', () => {
    const h = harness(
      'abcd',
      [
        [0, 2],
        [3, 4],
      ],
      [],
      1
    );
    cmd.insertLineBreak()(h.view);
    expect(h.text()).toBe('\nc\n');
    expect(h.ranges()).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(h.mainIndex()).toBe(1);
    expect(h.main()).toEqual([3, 3]);
  });

  it('只读：不改文档、返回 false（与它替换掉的原生命令同口径）', () => {
    const h = harness('ab', [[1, 1]], [EditorState.readOnly.of(true)]);
    expect(cmd.insertLineBreak()(h.view)).toBe(false);
    expect(h.text()).toBe('ab');
    expect(h.main()).toEqual([1, 1]);
  });

  it('进撤销历史：一步退回（不是整块跳回，也不是撤不掉）', () => {
    const h = harness('ab', [[1, 1]], [history()]);
    cmd.insertLineBreak()(h.view);
    expect(h.text()).toBe('a\nb');
    expect(cmd.undoCommand(h.view)).toBe(true);
    expect(h.text()).toBe('ab');
    expect(cmd.redoCommand(h.view)).toBe(true);
    expect(h.text()).toBe('a\nb');
  });
});

describe('撤销 / 重做', () => {
  it('命令进撤销历史，且能逐步退回', () => {
    const h = harness('hello', [[0, 5]], [history()]);
    cmd.toggleWrap('**')(h.view);
    expect(h.text()).toBe('**hello**');

    expect(cmd.undoCommand(h.view)).toBe(true);
    expect(h.text()).toBe('hello');

    expect(cmd.redoCommand(h.view)).toBe(true);
    expect(h.text()).toBe('**hello**');
  });
});
