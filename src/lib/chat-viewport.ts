// ─────────────────────────────────────────────────────────────────────────────
// chat-viewport.ts —— 讨论区整屏工作台的「软键盘让位」纯逻辑（零依赖）
//
// 【要解决的问题】`.chat-page` 的高度是 `calc(100dvh - 顶栏)`。`dvh` 跟着**地址栏**
// 收放，但 iOS Safari 弹软键盘时**不改变布局视口**（`innerHeight` / `dvh` 多半不动），
// 只改变 `visualViewport`。于是键盘从下方盖住输入区，而讨论页本身没有滚动条 ——
// 用户在讨论区打字时看不见自己正在输入的那一行。
//
// 【做法】键盘弹起时用 `visualViewport` 的几何把工作台下沿钉到**可视区下沿**：
//   · `visualViewport.height` 是可视区高度；
//   · `visualViewport.offsetTop` 是可视区顶端相对布局视口的偏移（iOS 为露出被聚焦
//     的输入框，会把可视区往上推，此时它 > 0）。
//   工作台顶端固定在布局坐标的顶栏之下，所以下沿（布局坐标）= offsetTop + height。
//   本模块只算这一个数（`chatViewportBottomPx`），CSS 那边再减顶栏高度 —— 减法只写一处。
//
// 【为什么守着不写 CSS，而让 useChatViewport 写到元素上】高度值随键盘动画每帧变，
// 走 React state 会把整棵消息列表重渲一遍。写成元素上的自定义属性（`--chat-vv-bottom`）
// 只触发一次样式重算。本文件保持纯函数 + 一个直写 DOM 的小工具，便于单测。
//
// 【三道闸门，缺一个都会「误以为键盘弹起」】
//   · 只认**触屏**（coarse pointer）：桌面缩放窗口也会改 `visualViewport`；
//   · 只认**未缩放**（scale ≈ 1）：双指捏合放大时 `height` 同样变小，那不是键盘，
//     照键盘处理会把界面按捏合倍率挤扁；
//   · 收缩要**够大**（≥ KEYBOARD_MIN_PX）：地址栏收放只有几十 px，那不是键盘。
//
// 【本模块不碰的】不写 `overflow: hidden`、不主动滚动、不 import 任何带副作用的模块
// —— 它只回答「下沿应当在布局坐标的哪个 y」，以及把那个数写进一个自定义属性。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写在讨论区根元素上的自定义属性名（由 `useChatViewport` 维护）。
 *
 * CSS 侧用法：`height: calc(var(--chat-vv-bottom, 100dvh) - var(--navbar-height))`。
 * **未设置时回退 `100dvh`** —— 于是桌面 / 不支持 visualViewport / 键盘未弹起时，
 * 这一条与 dvh 那一档完全等价，等于改版前行为。
 */
export const CHAT_VV_BOTTOM_VAR = '--chat-vv-bottom';

/**
 * 视口收缩到这个像素数以上，才认定是软键盘。
 *
 * iOS 键盘在竖屏下约 216px 起，而地址栏收放只带来几十 px 的变化（各家 0–100px）。
 * 取 120px 区分常见地址栏变化；这是启发式判据，需要在目标 iOS 设备上验收。
 * 不缩小可视区的浮动键盘无法通过这组几何读数识别。
 */
export const KEYBOARD_MIN_PX = 120;

/** 缩放判定容差：`visualViewport.scale` 在未缩放时是 1，浮点比较留一点余量。 */
export const ZOOM_EPSILON = 0.01;

/** `chatViewportBottomPx` 的入参（全部来自 `window` / `window.visualViewport`）。 */
export interface ChatViewportInput {
  /** 浏览器是否提供 `window.visualViewport`。 */
  supported: boolean;
  /** 是否触屏（`matchMedia('(pointer: coarse)')`）—— 桌面永不进入键盘分支。 */
  coarsePointer: boolean;
  /** `visualViewport.scale`：捏合缩放时 != 1，此时一律不当作键盘。 */
  scale: number;
  /** `window.innerHeight`（布局视口高度）。 */
  innerHeight: number;
  /** `visualViewport.height`（可视区高度，键盘弹起时会变小）。 */
  vvHeight: number;
  /** `visualViewport.offsetTop`（可视区顶端偏移）。 */
  vvOffsetTop: number;
}

/**
 * 计算工作台下沿应当落在**布局坐标**的哪个 y（px）；不该让位时返回 `null`。
 *
 * 返回的是「可视区下沿」而不是「高度」：CSS 那边统一减顶栏高度，减法只写一处，
 * 这里无需知道顶栏多高。返回 `null` 表示调用方应清掉自定义属性、退回 dvh 兜底。
 */
export function chatViewportBottomPx(input: ChatViewportInput): number | null {
  if (!input.supported || !input.coarsePointer) return null;
  if (![input.scale, input.innerHeight, input.vvHeight, input.vvOffsetTop].every(Number.isFinite)) return null;
  if (input.scale <= 0 || input.innerHeight <= 0 || input.vvHeight <= 0 || input.vvOffsetTop < 0) return null;
  // 捏合缩放不是键盘：放大时 height 也会变小，但界面不该跟着被挤。
  if (Math.abs(input.scale - 1) > ZOOM_EPSILON) return null;
  // 收缩不够大 → 多半只是地址栏收放，交给 dvh。
  if (input.innerHeight - input.vvHeight < KEYBOARD_MIN_PX) return null;

  const bottom = input.vvOffsetTop + input.vvHeight;
  if (!Number.isFinite(bottom) || bottom <= 0) return null;
  return Math.round(bottom);
}

/**
 * 把下沿写进/清除讨论区根元素的自定义属性（幂等：值与现值相同就不碰 DOM）。
 *
 * `null` → 移除属性，退回 `dvh` 兜底。返回值表示这次是否**实际改动了**元素，
 * 便于用例断言「重复调用不产生多余写入」。
 */
export function applyChatViewportBottom(el: HTMLElement, bottomPx: number | null): boolean {
  const current = el.style.getPropertyValue(CHAT_VV_BOTTOM_VAR);
  if (bottomPx == null) {
    if (!current) return false;
    el.style.removeProperty(CHAT_VV_BOTTOM_VAR);
    return true;
  }
  const next = `${bottomPx}px`;
  if (current === next) return false;
  el.style.setProperty(CHAT_VV_BOTTOM_VAR, next);
  return true;
}
