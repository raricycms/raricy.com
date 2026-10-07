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
//   1. `dispatch({ selection })` 里的数字按**新文档**解释，不是旧文档。任何
//      「插了几个字符之后光标该在哪」都得自己算；
//   2. 多区间时后面的区间还要再往前挪——前面每一条改动都把它整体推走了自己
//      插入的字符数。这两件事统一由 applyEdits 收口，命令只报「本区间自己的
//      净变化 + 只有这一条改动时的落点」，别再在命令里手算累计偏移。
//      写错的表现：单光标全对、多光标落到别处（或直接抛 Selection points
//      outside of document），而工具条上完全看不出异常。
// ─────────────────────────────────────────────────────────────────────────────

import { EditorSelection, type ChangeSpec } from '@codemirror/state';
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
      // 选区要跟着**本区间前面那些行**的增删一起挪（range 里给的是旧坐标）
      let fromDelta = 0;
      let toDelta = 0;
      const shift = (lineFrom: number, delta: number) => {
        if (lineFrom <= range.from) fromDelta += delta;
        if (lineFrom <= range.to) toDelta += delta;
      };
      lines.forEach((line, i) => {
        if (allPrefixed) {
          const prefix = ordered ? (line.text.match(/^\d+\.\s/) ?? [''])[0] : prefixFor(i);
          if (prefix) {
            changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
            shift(line.from, -prefix.length);
            net -= prefix.length;
          }
        } else {
          const prefix = prefixFor(i);
          changes.push({ from: line.from, insert: prefix });
          shift(line.from, prefix.length);
          net += prefix.length;
        }
      });
      edits.push({
        changes,
        shift: net,
        from: range.from + fromDelta,
        to: range.to + toDelta,
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
      // 同 toggleLinePrefix：选区要跟着前面那些行的增删挪
      let fromDelta = 0;
      let toDelta = 0;
      const shift = (lineFrom: number, delta: number) => {
        if (lineFrom <= range.from) fromDelta += delta;
        if (lineFrom <= range.to) toDelta += delta;
      };
      for (let n = first; n <= last; n += 1) {
        const line = state.doc.line(n);
        if (outdent) {
          const matched = line.text.match(/^(?:\t| {1,2})/);
          if (matched) {
            changes.push({ from: line.from, to: line.from + matched[0].length, insert: '' });
            shift(line.from, -matched[0].length);
            net -= matched[0].length;
          }
        } else {
          changes.push({ from: line.from, insert: indentUnit });
          shift(line.from, indentUnit.length);
          net += indentUnit.length;
        }
      }
      edits.push({
        changes,
        shift: net,
        from: range.from + fromDelta,
        to: range.to + toDelta,
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
    view.dispatch({
      changes: { from: line.from, to: line.from + removed, insert },
      selection: { anchor: at + insert.length - removed },
    });
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
