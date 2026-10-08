// ─────────────────────────────────────────────────────────────────────────────
// md-editor/commands.ts —— 工具条的**事务命令**（纯逻辑，不碰 React / DOM 结构）
//
// 【为什么单独立一层】工具条按钮、快捷键、面板插入全都要落到同一批命令上。
// 命令一律通过 `view.dispatch({ changes, selection })` 改文档 —— 于是：
//   · 每一步都进撤销历史（Ctrl+Z 能逐步退回，而不是整块跳回）；
//   · 选区由 CM6 自己按 change 映射，不靠「先 setSelectionRange 再赋值」那套
//     textarea 时代的做法（那套在 CM6 管的 DOM 上直接失效）。
//
// 【多选区策略】格式命令逐区间应用（CM6 原生就是 Range 数组），资源选择这类
// 由调用方只作用于主选区 —— 见 §4.2。
//
// 【零依赖】本模块只 import @codemirror/*，不拖 prisma / React。单测直接构造
// EditorState 跑命令，不必挂真 DOM。
//
// ⚠️ **选区坐标是这个文件里唯一容易写错的地方**，两条规则：
//   1. `dispatch({ selection })` 里的数字按**新文档**解释，不是旧文档；
//   2. 多区间时后面的区间还要再往前挪——前面每一条改动都把它整体推走了自己
//      插入的字符数。这件事统一由 applyEdits 收口（累加前面各区间自己的净变化），
//      命令只报「本区间自己的净变化 + 只有这一条改动时的落点」。
//
// ⚠️ **行前缀那一族命令一律用 `ChangeSet.mapPos` 算落点，不许手算
// `位置 ± 前缀长度`** —— 手算在新旧坐标之间做加减，删掉行首那几个字符时很容易
// 减出负数：光标停在 `# heading` / `- item` / `  item` 的行首时点「正文」「取消
// 列表」「减少缩进」，落点算成 `0 - 2 = -2`。**那一步不报错**（CM6 收下了这个
// 越界选区），下一次改动才炸：`RangeError: Invalid change range -2 to -2`
// —— 报错的是点粗体那一下，跟真正出问题的命令隔着好几步。
// 映射语义由 CM6 给：贴右（assoc 1）落到这段改动的**新内容末端** —— 落在被删 /
// 被替换区间**内部**的位置收口到区间**终点**（纯删除时新内容为空，起点与终点重合，
// 所以不会越界），正好在插入点上的位置落到插入内容的**后面**（光标跟着文字走，
// 而不是留在插入的前缀之前）。
// ─────────────────────────────────────────────────────────────────────────────

import { ChangeSet, EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';

/** CM6 的 Command 形状：返回 true = 处理了这次按键（用于 keymap 链）。 */
export type EditorCommand = (view: EditorView) => boolean;

/** 每个区间要落的一条改动 + 改完之后该区间的选区（见文件头第 2 条）。 */
interface RangeEdit {
  changes: ChangeSpec[];
  /** 本区间改动的**净长度变化**：插入字符数 − 删除字符数。 */
  shift: number;
  /** 选区落点，按「整篇里只有这一条改动」时的坐标给。 */
  from: number;
  to: number;
}

/** 把逐区间的改动按位置排序后一次 dispatch（CM6 要求 changes 有序且不重叠）。 */
function applyEdits(view: EditorView, edits: RangeEdit[]): boolean {
  if (edits.length === 0) return false;
  const changes = edits.flatMap((e) => e.changes);
  // 区间按位置升序，所以顺序累加前面每一条的净变化即可
  let acc = 0;
  const selection = EditorSelection.create(
    edits.map((e) => {
      const range = EditorSelection.range(e.from + acc, e.to + acc);
      acc += e.shift;
      return range;
    }),
    0
  );
  view.dispatch({ changes, selection });
  return true;
}

/**
 * 行内成对标记（粗体 / 斜体 / 删除线 / 行内代码 / 行内公式）。
 *
 * 已包住时**脱掉**，否则包上；空选区插占位符并选中它（接着打字就替换掉占位）。
 * 「已包住」的判据是标记紧贴在选区两侧 —— 不做「选区内部含标记」的模糊判断，
 * 那种判断在嵌套场景下会猜错（`**a*b*c**` 到底该脱哪一对没有唯一答案）。
 */
export function toggleWrap(marker: string, placeholder = ''): EditorCommand {
  return (view) => {
    const { state } = view;
    const edits: RangeEdit[] = [];
    for (const { from, to } of state.selection.ranges) {
      const before = state.sliceDoc(Math.max(0, from - marker.length), from);
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + marker.length));
      if (before === marker && after === marker) {
        edits.push({
          changes: [
            { from: from - marker.length, to: from, insert: '' },
            { from: to, to: to + marker.length, insert: '' },
          ],
          shift: -2 * marker.length,
          from: from - marker.length,
          to: to - marker.length,
        });
      } else {
        const inner = state.sliceDoc(from, to);
        const text = from === to ? placeholder : inner;
        const inserted = `${marker}${text}${marker}`;
        edits.push({
          changes: [{ from, to, insert: inserted }],
          shift: inserted.length - (to - from),
          from: from + marker.length,
          to: from + marker.length + text.length,
        });
      }
    }
    return applyEdits(view, edits);
  };
}

/**
 * 行首标记（无序列表 / 有序列表 / 任务列表 / 引用）。
 *
 * `prefixFor(i)` 拿到的是**行序号**（从 0 起，按选区内的行顺序），有序列表靠它
 * 重新编号 —— 中途插一行时后面的号码会跟着顺延，而不是全卡在 `1.`。
 * 选区碰到的所有行都已有标记时整块脱掉，否则全部加上（不做「只加缺的那几行」，
 * 那样在混排选区里会得到半截结果）。
 *
 * `ordered` 是**显式开关**而不是「看 prefix 长什么样」：有序列表每行的标记都不同
 * （`1. ` / `2. ` …），判「已有」只能按形状认。让调用方说清楚比在正则里猜可靠 ——
 * 猜错的表现是「点一下加、再点一下还是加」，静默且只有肉眼能发现。
 */
function toggleLinePrefix(prefixFor: (index: number) => string, ordered: boolean): EditorCommand {
  return (view) => {
    const { state } = view;
    const edits: RangeEdit[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      const lines = [];
      for (let n = first; n <= last; n += 1) lines.push(state.doc.line(n));

      // 「全部已有」才脱 —— 混排时按「加」处理
      const allPrefixed = lines.every((line) =>
        ordered ? /^\d+\.\s/.test(line.text) : line.text.startsWith(prefixFor(0))
      );

      const changes: ChangeSpec[] = [];
      let net = 0;
      lines.forEach((line, i) => {
        if (allPrefixed) {
          const prefix = ordered ? (line.text.match(/^\d+\.\s/) ?? [''])[0] : prefixFor(i);
          if (prefix) {
            changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
            net -= prefix.length;
          }
        } else {
          const prefix = prefixFor(i);
          changes.push({ from: line.from, insert: prefix });
          net += prefix.length;
        }
      });
      // 落点交给 CM6 映射（见文件头那段 ⚠️）：贴右，光标跟着文字走
      const own = ChangeSet.of(changes, state.doc.length);
      edits.push({
        changes,
        shift: net,
        from: own.mapPos(range.from, 1),
        to: own.mapPos(range.to, 1),
      });
    }
    return applyEdits(view, edits);
  };
}

/** 无序列表。 */
export const toggleBulletList: EditorCommand = toggleLinePrefix(() => '- ', false);
/** 任务列表。 */
export const toggleTaskList: EditorCommand = toggleLinePrefix(() => '- [ ] ', false);
/** 引用块。 */
export const toggleQuote: EditorCommand = toggleLinePrefix(() => '> ', false);
/** 有序列表（每行按序号重新编号）。 */
export const toggleOrderedList: EditorCommand = toggleLinePrefix((i) => `${i + 1}. `, true);

/** 行首缩进 / 反缩进（每级两个空格）。制表符统一按「先转成空格再退」处理。 */
export function shiftIndent(outdent: boolean, indentUnit = '  '): EditorCommand {
  return (view) => {
    const { state } = view;
    const edits: RangeEdit[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      const changes: ChangeSpec[] = [];
      let net = 0;
      for (let n = first; n <= last; n += 1) {
        const line = state.doc.line(n);
        if (outdent) {
          const matched = line.text.match(/^(?:\t| {1,2})/);
          if (matched) {
            changes.push({ from: line.from, to: line.from + matched[0].length, insert: '' });
            net -= matched[0].length;
          }
        } else {
          changes.push({ from: line.from, insert: indentUnit });
          net += indentUnit.length;
        }
      }
      // 同 toggleLinePrefix：落点由 CM6 映射，不手算（行首反缩进会算出负坐标）
      const own = ChangeSet.of(changes, state.doc.length);
      edits.push({
        changes,
        shift: net,
        from: own.mapPos(range.from, 1),
        to: own.mapPos(range.to, 1),
      });
    }
    return applyEdits(view, edits);
  };
}

/**
 * 标题级别 —— level 0 = 正文（脱掉 `#`）。
 *
 * 只动**主选区的起始行**：标题是块级语义，给多行选区加 `## ` 会把每一行都变成
 * 标题，那是用户几乎不要的结果（要连排标题应该逐行自己按）。
 * 判据用 `main.from` 而不是 `main.head`：拖动选出三行时 head 在**末行**，
 * 「点标题却把最后一行变成标题」是最容易被当成 bug 报上来的那种行为。
 */
export function setHeading(level: number): EditorCommand {
  return (view) => {
    const { state } = view;
    const at = state.selection.main.from;
    const line = state.doc.lineAt(at);
    const existing = line.text.match(/^#{1,6}\s+/);
    const removed = existing ? existing[0].length : 0;
    const insert = level === 0 ? '' : `${'#'.repeat(level)} `;
    // ★ 落点走 ChangeSet 映射，不写 `at + insert.length - removed` ★
    // 那个式子假定光标在**被换掉的那几个井号之后**；光标停在行首时它算出负数
    //（`# heading` 上点「正文」= `0 + 0 - 2`），而那一步不报错，等下一次格式
    // 操作才抛 `Invalid change range`（见文件头那段 ⚠️）。
    const changes = ChangeSet.of({ from: line.from, to: line.from + removed, insert }, state.doc.length);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(at, 1) } });
    return true;
  };
}

/**
 * 插入链接。选中的文字当标题，否则插占位并在选中状态让用户直接打字。
 * 光标停在**标题**上而不是 URL 上 —— 绝大多数情况下标题才是要改的那个。
 */
export function insertLink(): EditorCommand {
  return (view) => {
    const { state } = view;
    const edits: RangeEdit[] = [];
    for (const { from, to } of state.selection.ranges) {
      const text = state.sliceDoc(from, to) || '链接文字';
      const markdown = `[${text}](url)`;
      edits.push({
        changes: [{ from, to, insert: markdown }],
        shift: markdown.length - (to - from),
        from: from + 1,
        to: from + 1 + text.length,
      });
    }
    return applyEdits(view, edits);
  };
}

/** 插入围栏代码块。选中的内容原样放进围栏里（不缩进、不转义 —— 保真优先）。 */
export function insertCodeBlock(): EditorCommand {
  return (view) => {
    const { state } = view;
    const edits: RangeEdit[] = [];
    for (const { from, to } of state.selection.ranges) {
      const inner = state.sliceDoc(from, to);
      const text = `\`\`\`\n${inner}\n\`\`\``;
      edits.push({
        changes: [{ from, to, insert: text }],
        shift: text.length - (to - from),
        from: from + 4,
        to: from + 4 + inner.length,
      });
    }
    return applyEdits(view, edits);
  };
}

/** 插入表格骨架。放在选区处（整块替换选区，避免半截插在行中间）。 */
export function insertTable(): EditorCommand {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const atLineStart = line.from === range.from;
    const text =
      (atLineStart ? '' : '\n') +
      '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n';
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
    });
    return true;
  };
}

/** 分隔线。前后补换行，免得把 `---` 粘在上一行末尾（那样会被读成 setext 标题）。 */
export function insertHorizontalRule(): EditorCommand {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const text = (line.from === range.from ? '' : '\n') + '---\n';
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
    });
    return true;
  };
}

/** 在选区处插入一段纯文本（表情等）。有选区就替换它。 */
export function insertText(text: string, selectInserted = false): EditorCommand {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: selectInserted
        ? { anchor: range.from, head: range.from + text.length }
        : { anchor: range.from + text.length },
    });
    return true;
  };
}

/**
 * 单行换行（Shift+Enter）：在光标 / 选区处**只插一个换行符**，别的一概不做。
 *
 * 【为什么不能直接用 Enter 那两条默认命令】它们各自都还要多做一件事，都不是
 * 「只换一行」：
 *   · `insertNewlineContinueMarkup`（Markdown 语言自带，优先级高于默认键位表）
 *     在列表 / 引用块里会**续写标记** —— 回车是「新建下一项」，敲一下多一行 `- `；
 *   · `insertNewlineAndIndent` 在光标夹于 `()` / `[]` / `{}` 之间时会**再补一个
 *     换行**（@codemirror/commands 的 isBetweenBrackets）。正文里写
 *     `[文字](地址)` 这类再常见不过，于是按一次回车，成品里凭空多出一个空行
 *     —— 渲染出来就是「一次换行看着像两行」。
 *
 * 两条都**保留不动**（它们是 Markdown 惯用的输入方式，改掉等于「回车坏了」）；
 * 这条命令提供的是**绕开它们**的那条出口，绑在 Shift+Enter 上（见 MarkdownEditor.tsx
 * 的键位表，必须排在 defaultKeymap 之前）。
 *
 * 【渲染侧不需要任何标记】整篇渲染器（`renderBlogMarkdown`，gfm + breaks）把单个
 * `\n` 渲染成一个 `<br>`，两个 `\n` 才是两段。所以这里只插 `\n`：
 * **不插 `<br>`**（那是把渲染语义写进源文，改渲染口径时它就成了字面量），
 * **也不插行尾两个空格**（会被编辑器与补丁工具悄悄吃掉，且末行会被 Markdown 参数
 * 里的 `trim` 吃掉 —— 静默少一个换行）。
 */
export function insertLineBreak(): EditorCommand {
  return (view) => {
    const { state } = view;
    // 与它替换掉的那条原生命令同口径：只读下一律不动文档、返回 false。
    // `dispatch` 本身**不拦**只读（readOnly 是给编辑 DOM 与键位表看的），得自己判。
    if (state.readOnly) return false;
    // ★ 用 `state.replaceSelection`（内部就是 `changeByRange`），不用 applyEdits ★
    // applyEdits 收尾写死 `EditorSelection.create(ranges, 0)` —— 多光标时会把**主
    // 选区**打回第一个区间。Shift+Enter 换掉的原生命令（`insertNewlineAndIndent`）
    // 保持主选区，下游读 `selection.main`（资源面板以 `main.head` 作锚点）拿到的
    // 就是它；`changeByRange` 用 `sel.mainIndex` 收口，这里因此与替换前一致。
    // 有选区时整体替换成一个 `\n`，与 `insertText` 同口径。
    view.dispatch(state.replaceSelection('\n'));
    return true;
  };
}

/** 块级公式（`$$…$$`，独占若干行）。行内公式用 toggleWrap('$') 即可。 */
export function insertMathBlock(placeholder = 'x^2'): EditorCommand {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const inner = state.sliceDoc(range.from, range.to) || placeholder;
    const line = state.doc.lineAt(range.from);
    const lead = line.from === range.from ? '' : '\n';
    const text = `${lead}$$\n${inner}\n$$\n`;
    const start = range.from + lead.length + 3;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: start, head: start + inner.length },
    });
    return true;
  };
}

/** 撤销 / 重做 —— 直接用 @codemirror/commands 的实现（带分组，与键入合批）。 */
export const undoCommand: EditorCommand = (view) => undo(view);
export const redoCommand: EditorCommand = (view) => redo(view);
