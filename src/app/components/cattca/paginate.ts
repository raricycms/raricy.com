// ─────────────────────────────────────────────────────────────────────────────
// paginate.ts —— 把一段 Markdown 渲染后的 HTML 切成「一页」的 HTML。
//
// 阅读器的分页单位是 **引擎段**（一次 input 之前的所有输出）。每段单独分页，
// 段与段之间强制换页；段内按块级元素（p / h1 / li / blockquote …）切页。
// 单个段落比整页还高时，用 Range 在字符边界上继续切（这是唯一能保住长段落的
// 办法，否则 demo 的教程段和《防御》的战斗段会变成一个巨大的滚动页）。
//
// 分页必须用真实 DOM 量高度。measure 容器和最终页面共用
// `.cattca-reader__page-content` 的排版（字体、行高、块间距），所以量出来的
// 高度就是最终高度。
//
// 本文件不依赖 React；单元测试可以用 mock 的 scrollHeight 驱动。
// ─────────────────────────────────────────────────────────────────────────────

export interface PageMetrics {
  /** 正文可用宽度（px，不含页边距）。 */
  width: number;
  /** 正文可用高度（px，不含页脚页码）。 */
  height: number;
  /** 实际页面正文的计算样式；量高度时必须一致，否则分页会偏。 */
  fontSize?: string;
  lineHeight?: string;
  fontFamily?: string;
  /** 块间距与对齐方式；同样从真实页面抄来，避免 SCSS 改了分页还按老值量。 */
  gap?: string;
  textAlign?: string;
}

const MIN_PAGE_SIZE = 80;

/** 页码换算：把任意页码夹到 [0, total-1]。 */
export function clampPage(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}

/** 书页模式下的左侧页起点。书页不再强制「偶数页在左」——段可能从任意页开始，
 *  强制对齐会把读者从第 3 页弹回第 1 页。这里只保证不越界。 */
export function spreadStart(index: number, _spread: boolean): number {
  return Math.max(0, Math.trunc(index));
}

/** 一次翻页的步长：单页 1，书页对开 2。 */
export function pageStep(spread: boolean): number {
  return spread ? 2 : 1;
}

/** 在页码边界内移动。 */
export function movePage(index: number, delta: number, total: number, spread: boolean): number {
  const step = pageStep(spread);
  const next = spreadStart(index, spread) + delta * step;
  if (next < 0) return 0;
  if (total <= 0) return 0;
  if (next >= total) {
    // 停在最后一页；书页模式下最后一页单独显示。
    return total - 1;
  }
  return next;
}

/** 当前可见页的页码列表（0 基）。 */
export function visiblePageIndexes(index: number, total: number, spread: boolean): number[] {
  if (total <= 0) return [];
  const start = spreadStart(clampPage(index, total), spread);
  const result = [start];
  if (spread && start + 1 < total) result.push(start + 1);
  return result;
}

const MEASURE_CLASS = 'cattca-reader__page-content cattca-reader__page-content--measure';
const BLOCK_GAP = '0.85em';

function makeMeasure(width: number, metrics: PageMetrics): HTMLDivElement {
  const measure = document.createElement('div');
  measure.className = MEASURE_CLASS;
  measure.style.position = 'fixed';
  measure.style.left = '-10000px';
  measure.style.top = '0';
  measure.style.width = `${width}px`;
  measure.style.height = 'auto';
  measure.style.visibility = 'hidden';
  measure.style.pointerEvents = 'none';
  measure.style.display = 'flex';
  measure.style.flexDirection = 'column';
  measure.style.gap = metrics.gap ?? BLOCK_GAP;
  if (metrics.fontSize) measure.style.fontSize = metrics.fontSize;
  if (metrics.lineHeight) measure.style.lineHeight = metrics.lineHeight;
  if (metrics.fontFamily) measure.style.fontFamily = metrics.fontFamily;
  if (metrics.textAlign) measure.style.textAlign = metrics.textAlign;
  document.body.appendChild(measure);
  return measure;
}

function textOf(el: Element): string {
  return el.textContent ?? '';
}

function textLength(el: Element): number {
  return textOf(el).length;
}

/** 把 marked 的顶层节点整理成可分页的块。 */
function normalizeBlocks(root: ParentNode): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  const doc = document;

  const add = (el: HTMLElement) => {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;

    // 宽表格不能撑破页面：套一层横向滚动容器。表格本身保持 table 布局。
    if (el.tagName === 'TABLE') {
      const wrap = doc.createElement('div');
      wrap.className = 'cattca-reader__table-scroll';
      wrap.appendChild(el.cloneNode(true));
      blocks.push(wrap);
      return;
    }

    // 列表：一个 li 一个块，这样可以在条目之间换页。
    // 每个条目被拆成独立的 <ol>，必须写回 start，否则第 5–10 项会重新从 1 编号。
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      const items = Array.from(el.children).filter((child) => child.tagName === 'LI');
      const ordered = el.tagName === 'OL';
      const reversed = ordered && el.hasAttribute('reversed');
      const startAttr = el.getAttribute('start');
      const declaredStart = startAttr == null ? NaN : Number(startAttr);
      const base = reversed
        ? (Number.isFinite(declaredStart) ? declaredStart : items.length)
        : (Number.isFinite(declaredStart) ? declaredStart : 1);
      for (let index = 0; index < items.length; index += 1) {
        const list = el.cloneNode(false) as HTMLElement;
        if (ordered) {
          list.setAttribute('start', String(reversed ? base - index : base + index));
        }
        list.appendChild(items[index].cloneNode(true));
        blocks.push(list);
      }
      return;
    }

    // 长引用：按子块拆成多个引用块，避免整段不可分页。
    if (el.tagName === 'BLOCKQUOTE') {
      const children = Array.from(el.children) as HTMLElement[];
      if (children.length > 1) {
        for (const child of children) {
          const quote = el.cloneNode(false) as HTMLElement;
          quote.appendChild(child.cloneNode(true));
          blocks.push(quote);
        }
        return;
      }
    }

    blocks.push(el);
  };

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.trim()) {
        const p = doc.createElement('p');
        p.textContent = text;
        blocks.push(p);
      }
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    add(node as HTMLElement);
  }
  return blocks;
}

interface TextView {
  node: Text;
  start: number;
  end: number;
}

function textViews(root: Node): { views: TextView[]; total: number } {
  const views: TextView[] = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node as Text;
    const len = text.nodeValue?.length ?? 0;
    if (len > 0) {
      views.push({ node: text, start: total, end: total + len });
      total += len;
    }
    node = walker.nextNode();
  }
  return { views, total };
}

function pointAt(views: TextView[], offset: number): { node: Text; offset: number } | null {
  for (const view of views) {
    if (offset >= view.start && offset <= view.end) {
      return { node: view.node, offset: Math.min(view.node.nodeValue?.length ?? 0, offset - view.start) };
    }
  }
  return null;
}

function sliceInto(target: HTMLElement, from: number, to: number): HTMLElement {
  const clone = target.cloneNode(true) as HTMLElement;
  const { views, total } = textViews(clone);
  const wrapper = target.cloneNode(false) as HTMLElement;

  if (total === 0) return wrapper;

  const range = document.createRange();
  range.selectNodeContents(clone);
  if (from > 0) {
    const start = pointAt(views, from);
    if (start) range.setStart(start.node, start.offset);
  }
  if (to < total) {
    const end = pointAt(views, to);
    if (end) range.setEnd(end.node, end.offset);
  }
  try {
    wrapper.appendChild(range.cloneContents());
  } catch {
    // Range 在极端 DOM（例如 <br> 边界）下可能抛错，退回整块，避免丢内容。
    return target.cloneNode(true) as HTMLElement;
  }
  return wrapper;
}

function wrapSlice(
  block: HTMLElement,
  target: HTMLElement,
  slice: HTMLElement,
  continuation = false,
): HTMLElement {
  if (target === block) return slice;

  if (target.parentElement === block) {
    const outer = block.cloneNode(false) as HTMLElement;
    if (continuation && (block.tagName === 'OL' || block.tagName === 'UL')) {
      // 同一条目被切成两页：续页不重复列表标记（OL 会再印一个序号，UL 会再印一个点）。
      outer.style.listStyle = 'none';
    }
    outer.appendChild(slice);
    return outer;
  }

  // blockquote > p 这种一层嵌套。
  if (target.parentElement?.parentElement === block) {
    const outer = block.cloneNode(false) as HTMLElement;
    const mid = target.parentElement.cloneNode(false) as HTMLElement;
    mid.appendChild(slice);
    outer.appendChild(mid);
    return outer;
  }

  return block.cloneNode(true) as HTMLElement;
}

/** 找出这个块里「可以按字符切开」的目标；标题、表格、代码块不切。 */
function splittableTarget(block: HTMLElement): HTMLElement | null {
  if (block.tagName === 'P') return block;
  if (block.tagName === 'UL' || block.tagName === 'OL') {
    const li = Array.from(block.children).find((child) => child.tagName === 'LI') as HTMLElement | undefined;
    return li && textLength(li) > 1 ? li : null;
  }
  if (block.tagName === 'BLOCKQUOTE') {
    const child = Array.from(block.children)[0] as HTMLElement | undefined;
    if (child && (child.tagName === 'P' || child.tagName === 'LI') && textLength(child) > 1) return child;
  }
  return null;
}

function splitBlock(
  block: HTMLElement,
  height: number,
  measure: HTMLElement,
): { left: HTMLElement; right: HTMLElement } | null {
  const target = splittableTarget(block);
  if (!target) return null;
  const total = textLength(target);
  if (total < 2) return null;

  let lo = 1;
  let hi = total - 1;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const left = wrapSlice(block, target, sliceInto(target, 0, mid));
    measure.replaceChildren(left);
    if (measure.scrollHeight <= height) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best <= 0 || best >= total) return null;

  const left = wrapSlice(block, target, sliceInto(target, 0, best));
  const right = wrapSlice(block, target, sliceInto(target, best, total), true);
  if (!textOf(left).trim() || !textOf(right).trim()) return null;
  return { left, right };
}

/**
 * 把一段 HTML 分页。
 *
 * @param html       Markdown 渲染 + 消毒后的 HTML
 * @param metrics    正文字数尺寸（px）
 * @returns         至少一页的 HTML 字符串数组
 */
export function paginateHtml(html: string, metrics: PageMetrics): string[] {
  if (typeof document === 'undefined') return [html];
  if (!html || !html.trim()) return [''];

  const width = Math.max(MIN_PAGE_SIZE, Math.floor(metrics.width));
  const height = Math.max(MIN_PAGE_SIZE, Math.floor(metrics.height));

  const measure = makeMeasure(width, metrics);
  try {
    const template = document.createElement('template');
    template.innerHTML = html;
    const blocks = normalizeBlocks(template.content);
    if (blocks.length === 0) return [''];

    const pages: string[] = [];
    let current: HTMLElement[] = [];

    const measureCurrent = (): number => {
      measure.replaceChildren(...current.map((block) => block.cloneNode(true)));
      return measure.scrollHeight;
    };

    const flush = () => {
      if (current.length === 0) return;
      const wrapper = document.createElement('div');
      for (const block of current) wrapper.appendChild(block.cloneNode(true));
      pages.push(wrapper.innerHTML);
      current = [];
    };

    const placeOversized = (block: HTMLElement) => {
      let rest: HTMLElement | null = block;
      while (rest) {
        current = [rest];
        if (measureCurrent() <= height) {
          rest = null;
          break;
        }

        const split = splitBlock(rest, height, measure);
        if (!split) {
          // 表格 / 代码块 / 超长标题这类不可切的块：独占一页，允许页内滚动。
          flush();
          rest = null;
          break;
        }

        current = [split.left];
        flush();
        rest = split.right;
      }
    };

    for (const block of blocks) {
      if (current.length === 0) {
        current = [block];
        if (measureCurrent() <= height) continue;
        current = [];
        placeOversized(block);
        continue;
      }

      current.push(block);
      if (measureCurrent() <= height) continue;
      current.pop();
      flush();
      placeOversized(block);
    }

    flush();
    return pages.length > 0 ? pages : [''];
  } finally {
    measure.remove();
  }
}
