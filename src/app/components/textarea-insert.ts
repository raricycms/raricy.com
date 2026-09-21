// ─────────────────────────────────────────────────────────────────────────────
// textarea-insert.ts — 往输入框的光标处插入一段文本（@提及 / 表情 / 用户名片共用）
//
// 【为什么必须抽出来】@提及（ChatApp 的 insertMention）与表情（评论区）要做的是
// 同一件事，而它有三个踩过的坑，复制一份就是两处 drift：
//
//   1. **程序化赋值不触发 React 的 onChange** —— RichComposer 的 onChange 里那段
//      自动加高不会跑，输入框不跟着变长。所以这里手动补一次（与 RichComposer
//      用同一组数值：上限 176）。
//   2. **必须等 React 提交之后再量高** —— setText 之后立刻读 scrollHeight 量到的
//     是**旧内容**的高度。用 rAF 推到下一帧。
//   3. **先 focus 再 setSelectionRange** —— 反过来的话某些浏览器会把选区重置到末尾。
//
// 【为什么读 ta.value 而不是调用方传进来的 text】用户可能刚粘贴 / 拖拽改了 DOM，
// ta.value 才是他眼前看到的东西。返回的新串由调用方 setState 回灌，两边自然收敛。
//
// 【为什么还要 captureCaret / 显式传 range】用户名片的选择器是个**居中弹窗**（要输
// 搜索词 → 必须抢焦点），而「失焦之后还读不读得到 selectionStart」在各浏览器上并不
// 一致（StickerPicker 的文件头记着同一条）。所以点按钮那一刻先把选区**捕获**下来，
// 选完人再按那个区间插回去 —— 不赌失焦后的行为。
// ─────────────────────────────────────────────────────────────────────────────

/** 输入框自动加高的上限，与 RichComposer 的 onChange 保持一致。 */
const MAX_INPUT_HEIGHT = 176;

/** 一段选区。捕获下来之后即使输入框失焦，它仍然有效。 */
export interface CaretRange {
  start: number;
  end: number;
}

/**
 * 捕获当前的选区。
 *
 * ⚠️ 要在**点按钮的 mousedown** 里调 —— 等到 click 时焦点已经移到按钮上了。虽然多数
 * 浏览器会保留 textarea 的 selectionStart，但那是「行为一致」而不是「有保证」。
 * 输入框不在（没挂载 / 切了频道）时返回 null，调用方退回「追加到末尾」。
 */
export function captureCaret(ta: HTMLTextAreaElement | null): CaretRange | null {
  if (!ta) return null;
  const start = ta.selectionStart ?? ta.value.length;
  return { start, end: ta.selectionEnd ?? start };
}

/**
 * 在指定区间插入 snippet，返回插入后的完整文本（由调用方写回 state）。
 *
 * @param ta       输入框元素；为 null（组件已卸载 / 切了频道）时退化成「追加到末尾」
 * @param fallback ta 不可用时的兜底原文（通常是调用方持有的 state）
 * @param snippet  要插入的文本
 * @param range    要插入的区间（captureCaret 的产物）；传 null 表示「就用此刻的光标」
 */
export function insertAtRange(
  ta: HTMLTextAreaElement | null,
  fallback: string,
  snippet: string,
  range: CaretRange | null
): string {
  if (!ta) return fallback + snippet;

  const text = ta.value;
  // 捕获的区间可能已经越界（期间用户又改过正文）：夹回合法范围，别让 slice 静默截错
  const start = Math.min(Math.max(range ? range.start : (ta.selectionStart ?? text.length), 0), text.length);
  const end = Math.min(Math.max(range ? range.end : (ta.selectionEnd ?? start), start), text.length);
  const next = text.slice(0, start) + snippet + text.slice(end);

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

/**
 * 在 textarea 的光标处插入 snippet（= insertAtRange 用「此刻的光标」那一档）。
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
  return insertAtRange(ta, fallback, snippet, null);
}
