// ─────────────────────────────────────────────────────────────────────────────
// chat-message-interaction.ts —— 讨论消息的指针交互判据（零依赖）
//
// 这一份只放「判据」，不放 React / 不放 DOM 状态：长按阈值、滑动容差、
// 「这次点击算不算拖选 / 算不算在选区里右键」。ChatMessageItem 负责事件接线，
// 单测可以直接 import 这里的纯函数，不用挂整个消息组件。
//
// 【三种输入要分开处理，别合并成一套 click】
//   · 触屏（touch / pen）：按下要立刻给反馈；滑动（滚动列表）要取消反馈与长按；
//     长按开操作面板，松手后不能再补一个单击（否则面板刚开就同屏弹出详情）。
//   · 鼠标（fine pointer）：按住拖动是**选字**，不是「点了没动」；松手后的 click
//     不能当单击处理。所以「拖选结束」的判据必须同时看位移和当前选区。
//   · 键盘：contextmenu 事件没有指针坐标（clientX/Y 都是 0），不能拿坐标判断
//     「在不在选区里」，否则键盘菜单键会被误判成右键选区。
// ─────────────────────────────────────────────────────────────────────────────

/** 长按判定时长（毫秒）。与移动端浏览器原生长按菜单的常见阈值同档。 */
export const LONG_PRESS_MS = 500;

/**
 * 按下后允许的位移（像素）。超过即视为「在滑动 / 在拖选」，取消按下反馈与长按。
 * 手指按下的零点几像素抖动不该被判成滑动，所以要留容差。
 */
export const PRESS_MOVE_TOLERANCE_PX = 8;

/** 位移是否已超出容差（dx / dy 是当前点相对按下点的差值）。 */
export function movedBeyondTolerance(
  dx: number,
  dy: number,
  tolerance = PRESS_MOVE_TOLERANCE_PX
): boolean {
  return Math.abs(dx) > tolerance || Math.abs(dy) > tolerance;
}

/**
 * 当前是否有**非空文字选区**。
 * 用 `toString().trim()` 而不是只看 `isCollapsed`：双击 / 三击可能选中的是空白或
 * 行尾，此时 `isCollapsed` 为 false 但用户其实没选到字，不该因此吞掉单击。
 */
export function hasTextSelection(selection: Selection | null | undefined): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.toString().trim() !== '';
}

/** 事件目标是否在「自己处理点击」的控件里（链接 / 按钮 / 输入框）。 */
export function isInteractiveClickTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('a, button, input, textarea, select, label, [role="button"]');
}

/**
 * 事件目标是否是「按下时不该启动长按 / 按下反馈」的控件。
 * 比 `isInteractiveClickTarget` 少一个 `[role="button"]` 之外的差别不大，独立命名
 * 是为了以后「图片要长按、按钮不要」这类取舍只改一处。
 */
export function isPressExcludedTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('a, button, input, textarea, select, label');
}

interface CaretPoint {
  node: Node;
  offset: number;
}

/** 取坐标处的文本插入点。Chromium / Safari 用 caretRangeFromPoint，Firefox 用 caretPositionFromPoint。 */
function caretAtPoint(doc: Document, x: number, y: number): CaretPoint | null {
  const anyDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof anyDoc.caretPositionFromPoint === 'function') {
    const pos = anyDoc.caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (typeof anyDoc.caretRangeFromPoint === 'function') {
    const range = anyDoc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/**
 * 坐标是否落在给定 Range 之内。
 *
 * 【为什么用插入点比较而不是 `selection.containsNode`】containsNode 看的是「节点」：
 * 只要选区与这个节点有交集就为真，右键点在同一个 `<p>` 里的选区**之外**也会被判成
 * 「在选区内」，于是右键菜单静默失效 —— 用户只会觉得右键有时好使有时不好使。
 * 取落点处的 caret，再与 Range 的两端比较，才是「这一点是否被选中」。
 *
 * 判不出来（浏览器不支持 caret API / 落点不在文本上）一律返回 false：
 * 宁可打开我们自己的菜单，也不要吞掉浏览器菜单（吞掉就什么也没有了）。
 */
export function isPointInsideRange(doc: Document, x: number, y: number, range: Range): boolean {
  // 首选几何判据：选区每一行的 client rect 就是「被选中的那块文字」的可视范围。
  // 右键落在任何一行的范围内才算「在已选文字内」，比 caret 逐点比较更贴近用户
  // 看到的选区，也不依赖 caret API 的浏览器差异。
  const rects = range.getClientRects();
  if (rects.length > 0) {
    for (const rect of rects) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
    return false;
  }
  // 无排版信息（jsdom / 极端环境）时退回 caret 边界比较。
  const caret = caretAtPoint(doc, x, y);
  if (!caret) return false;
  if (!range.intersectsNode(caret.node)) return false;
  const probe = doc.createRange();
  probe.setStart(caret.node, caret.offset);
  probe.collapse(true);
  // range.start <= caret && range.end >= caret
  return (
    range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_START, probe) >= 0
  );
}

/** 右键落点是否落在当前文字选区之内（选区在 contextmenu 时通常还活着）。 */
export function isPointInsideSelection(doc: Document, x: number, y: number): boolean {
  const selection = doc.getSelection();
  if (!hasTextSelection(selection) || !selection) return false;
  return isPointInsideRange(doc, x, y, selection.getRangeAt(0));
}
