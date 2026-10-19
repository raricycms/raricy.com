'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Typewriter —— 按恒定速度把一页文字「打」出来。
//
// 做法：Markdown 已经渲染成 HTML，这里只操作其中的文本节点（不破坏标签）。
// 页面在分页阶段已经保证不会超高，所以边打边排版不会把内容挤出页面。
//
// 控制：
//   · 默认 ≈36 字/秒
//   · 按住 Shift ×8
//   · Ctrl（单独按一下）由父组件把本段页面标记为已显示，本页随即补完
//   · prefers-reduced-motion 下直接显示全文
// ─────────────────────────────────────────────────────────────────────────────

import { useLayoutEffect, useRef, type RefObject } from 'react';

export const TYPEWRITER_CPS = 36;

interface TextNodeView {
  node: Text;
  full: string;
  start: number;
  end: number;
}

const REVEAL_CONTAINERS = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TD',
  'TH',
]);

/** 文字节点所属的「显示单元」：优先取最外层的 p / li / blockquote / pre / 单元格。 */
function revealContainerOf(node: Text, root: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node.parentElement;
  let container: HTMLElement | null = null;
  while (current && current !== root) {
    if (REVEAL_CONTAINERS.has(current.tagName)) container = current;
    current = current.parentElement;
  }
  if (container) return container;
  // 兜底：取 root 的顶层子元素。
  let child: HTMLElement | null = node.parentElement;
  while (child && child.parentElement !== root) child = child.parentElement;
  return child;
}

interface TypewriterProps {
  html: string;
  pageKey: string;
  initiallyDone: boolean;
  /** 当前是否轮到这一页打字；对开页按左→右顺序依次激活。 */
  active: boolean;
  shiftHeld: RefObject<boolean>;
  reducedMotion: boolean;
  onDone: (pageKey: string) => void;
}

export default function Typewriter({
  html,
  pageKey,
  initiallyDone,
  active,
  shiftHeld,
  reducedMotion,
  onDone,
}: TypewriterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const appliedHtmlRef = useRef<string | null>(null);
  const viewsRef = useRef<TextNodeView[]>([]);
  const containersRef = useRef<Map<HTMLElement, number>>(new Map());
  const shownContainersRef = useRef<Set<HTMLElement>>(new Set());
  const totalRef = useRef(0);
  const revealedRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const stop = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const finish = () => {
    if (doneRef.current) return;
    stop();
    if (rootRef.current) delete rootRef.current.dataset.typing;
    for (const view of viewsRef.current) {
      if (view.node.nodeValue !== view.full) view.node.nodeValue = view.full;
    }
    for (const container of containersRef.current.keys()) {
      container.style.visibility = '';
    }
    shownContainersRef.current.clear();
    revealedRef.current = totalRef.current;
    doneRef.current = true;
    onDone(pageKey);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    stop();
    doneRef.current = false;
    revealedRef.current = 0;

    // ★ 不要用 dangerouslySetInnerHTML：父组件每次重渲染（分页、pending、状态）
    // 都可能让 React 重设 innerHTML，把打字机已经空掉的文本节点整段恢复，表现为
    // 「刚开始打字就全文出现」。这里由自己写入一次，之后只改文本节点。
    if (appliedHtmlRef.current !== html) {
      root.innerHTML = html;
      appliedHtmlRef.current = html;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const views: TextNodeView[] = [];
    let total = 0;
    let node = walker.nextNode();
    while (node) {
      const text = node as Text;
      const full = text.nodeValue ?? '';
      if (full.length > 0) {
        views.push({ node: text, full, start: total, end: total + full.length });
        total += full.length;
      }
      node = walker.nextNode();
    }
    viewsRef.current = views;
    totalRef.current = total;

    // 每个文字节点属于一个「显示单元」（p / li / blockquote / pre / 单元格）。
    // 未开始显示时把整个单元设为 visibility:hidden —— 只清空文字会让列表留下空圆点、
    // 引用留下空色块，看起来像排版坏了。visibility 不改变布局，打字时不会跳。
    const containers = new Map<HTMLElement, number>();
    for (const view of views) {
      const container = revealContainerOf(view.node, root);
      if (!container) continue;
      const existing = containers.get(container);
      if (existing === undefined || view.start < existing) containers.set(container, view.start);
    }
    containersRef.current = containers;
    shownContainersRef.current = new Set();

    const restore = () => {
      stop();
      delete root.dataset.typing;
      for (const container of containers.keys()) container.style.visibility = '';
      // StrictMode 会 mount → unmount → remount；若这里不还原，第二次 mount
      // 读到的文本节点已经被清空，会被误判成「空页面」。
      for (const view of views) view.node.nodeValue = view.full;
    };

    if (total === 0) {
      doneRef.current = true;
      onDone(pageKey);
      return restore;
    }

    if (initiallyDone || reducedMotion) {
      doneRef.current = true;
      onDone(pageKey);
      return restore;
    }

    // 不是当前这一页：先保持空白，不启动 rAF。等左页打完、active 变 true 再开始。
    if (!active) {
      for (const container of containers.keys()) container.style.visibility = 'hidden';
      for (const view of views) view.node.nodeValue = '';
      root.dataset.typing = 'waiting';
      return restore;
    }

    // 先清空，避免首帧闪出全文。
    for (const container of containers.keys()) container.style.visibility = 'hidden';
    for (const view of views) view.node.nodeValue = '';
    root.dataset.typing = 'true';

    const startedAt = performance.now();
    let last = startedAt;

    const tick = (now: number) => {
      if (doneRef.current) return;
      const delta = Math.max(0, (now - last) / 1000);
      last = now;
      const speed = TYPEWRITER_CPS * (shiftHeld.current ? 8 : 1);
      revealedRef.current = Math.min(total, revealedRef.current + delta * speed);
      const n = Math.floor(revealedRef.current);

      for (const [container, start] of containers) {
        if (n > start && !shownContainersRef.current.has(container)) {
          container.style.visibility = '';
          shownContainersRef.current.add(container);
        }
      }

      for (const view of views) {
        if (n >= view.end) {
          if (view.node.nodeValue !== view.full) view.node.nodeValue = view.full;
        } else if (n <= view.start) {
          if (view.node.nodeValue !== '') view.node.nodeValue = '';
        } else {
          const part = view.full.slice(0, n - view.start);
          if (view.node.nodeValue !== part) view.node.nodeValue = part;
        }
      }

      if (n >= total) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return restore;
    // html 变化时组件通常已经换 key；这里仍把 html 作为依赖，避免误复用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, pageKey, initiallyDone, active, reducedMotion]);

  return <div ref={rootRef} className="cattca-reader__page-content" />;
}
