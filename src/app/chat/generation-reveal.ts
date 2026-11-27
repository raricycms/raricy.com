// ─────────────────────────────────────────────────────────────────────────────
// generation-reveal.ts — 生成预览的“分步显示”计划（纯函数，零 React / 零 DOM）
//
// 服务端快照已降到 200ms 一帧；若前端每帧只渲染一次，视觉会从 10 帧/秒掉到
// 5 帧/秒。这里把每帧新增的源码切成两个累计进度点，由 ChatGenerationItem 先立即
// 显示第一段、100ms 后显示第二段，保持约 10 帧/秒的视觉节奏。
//
// 只切“上一版之后新增的后缀”，不重排旧内容；服务端若完整替换 / 回退源码
// （target 不以 current 开头），直接返回终点，让调用方跳到最新版而不是播放
// 一段过时的中间态。
// ─────────────────────────────────────────────────────────────────────────────

/** 每个 200ms 快照在前端分几次显示（2 次 = 100ms 一次，约 10 帧/秒）。 */
export const GENERATION_REVEAL_STEPS = 2;

/** 两个显示进度点之间的间隔。 */
export const GENERATION_REVEAL_INTERVAL_MS = 100;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 按“用户看到的字符”切分，而不是 UTF-16 码元或裸码点：
 * 代理对与 ZWJ 组合表情不能被拆成两半，否则中间态会闪一个替换符。
 * 不支持 Intl.Segmenter 的环境退回码点切分（至少不会拆代理对）。
 */
function segments(text: string): string[] {
  try {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (
          locale?: string,
          options?: { granularity?: 'grapheme' }
        ) => { segment(input: string): Iterable<{ segment: string }> };
      }
    ).Segmenter;
    if (Segmenter) {
      return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
    }
  } catch {
    // 旧运行时 / 被裁剪的 Intl：走码点回退。
  }

  const output: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) {
      output.push(text.slice(index, index + 2));
      index += 1;
    } else {
      output.push(text[index]);
    }
  }
  return output;
}

/**
 * 规划从 `current`（当前已显示）到 `target`（最新完整源码）的累计显示步骤。
 *
 * - 返回空数组：已经是最新版本，不需要更新；
 * - target 不以 current 开头：源码被替换 / 回退，返回 `[target]` 立即对齐；
 * - 否则返回若干累计源码，最后一个等于 target，调用方按数组顺序显示。
 */
export function planGenerationReveal(
  current: string,
  target: string,
  steps: number = GENERATION_REVEAL_STEPS
): string[] {
  if (current === target) return [];
  if (!target.startsWith(current)) return [target];

  const suffix = target.slice(current.length);
  if (suffix.length === 0) return [];

  const units = segments(suffix);
  if (units.length <= 1) return [target];

  const count = Math.min(Math.max(1, Math.floor(steps)), units.length);
  if (count === 1) return [target];

  const output: string[] = [];
  let cursor = current;
  let start = 0;
  for (let index = 1; index <= count; index += 1) {
    const end = index === count ? units.length : Math.ceil((units.length * index) / count);
    cursor += units.slice(start, end).join('');
    output.push(cursor);
    start = end;
  }
  return output;
}