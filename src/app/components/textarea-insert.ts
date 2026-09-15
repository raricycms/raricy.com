// ─────────────────────────────────────────────────────────────────────────────
// textarea-insert.ts — 往输入框的光标处插入一段文本（@提及 / 表情共用）
//
// 【为什么必须抽出来】@提及（ChatApp 的 insertMention）与表情（评论区）要做的是
// 同一件事，而它有三个踩过的坑，复制一份就是两处 drift：
//
//   1. **程序化赋值不触发 React 的 onChange** —— RichComposer 的 onChange 里那段
//      自动加高不会跑，输入框不跟着变长。所以这里手动补一次（与 RichComposer
//      用同一组数值：上限 176）。
//   2. **必须等 React 提交之后再量高** —— setText 之后立刻读 scrollHeight 量到的
//      是**旧内容**的高度。用 rAF 推到下一帧。
//   3. **先 focus 再 setSelectionRange** —— 反过来的话某些浏览器会把选区重置到末尾。
//
// 【为什么读 ta.value 而不是调用方传进来的 text】用户可能刚粘贴 / 拖拽改了 DOM，
// ta.value 才是他眼前看到的东西。返回的新串由调用方 setState 回灌，两边自然收敛。
// ─────────────────────────────────────────────────────────────────────────────

/** 输入框自动加高的上限，与 RichComposer 的 onChange 保持一致。 */
const MAX_INPUT_HEIGHT = 176;

/**
 * 在 textarea 的光标处插入 snippet，返回插入后的完整文本（由调用方写回 state）。
 *
 * @param ta       输入框元素；为 null（组件已卸载 / 切了频道）时退化成「追加到末尾」
 * @param fallback ta 不可用时的兜底原文（通常是调用方持有的 state）
 * @param snippet  要插入的文本
 */
export function insertAtCaret(
  ta: HTMLTextAreaElement | null,
  fallback: string,
  snippet: string
): string {
  if (!ta) return fallback + snippet;

  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + snippet + ta.value.slice(end);

  requestAnimationFrame(() => {
    ta.focus();
    const caret = start + snippet.length;
    ta.setSelectionRange(caret, caret);
    // 坑 1 + 坑 2：程序化赋值不触发 onChange，且必须等到下一帧才量得到新内容的高度
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(MAX_INPUT_HEIGHT, ta.scrollHeight)}px`;
  });

  return next;
}
