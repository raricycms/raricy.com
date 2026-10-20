'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ProfileBoard —— 个人主页的「积木墙」（客户端）
//
// 【职责切分】服务端已经把每块的内容解析成 BlockView（能看的才给），这里**不查库、
// 不判权限**，只负责：画、拖、改尺寸、增删、保存。唯一的网络动作是 PUT 整页布局。
//
// 【为什么整个 board 是客户端组件】只读时它本来可以全在服务端渲染；但「编辑模式」
// 要复用同一套卡片渲染，拆成两个组件必然漂移（一边能拖、一边不能，样式也会分叉）。
// 客户端组件在首屏一样会被服务端渲染成 HTML，所以访客拿到的仍是 SSR 内容。
//
// 【两端是同一份坐标，不是两套布局】桌面 4 列自由网格是唯一真相（位置 = x/y）；
// 手机的 2 列由 projectMobile 从它**投影**出来（宽 ≥2 通栏，宽 1 看左右半，顺序按
// 桌面 (y,x) 紧排）。手机上拖动 / 左右移动 / 上下移动改的都是桌面坐标 —— 于是两端
// 永远显示同一份布局，不会出现「桌面改完手机还是旧的」。
//
// 【手机上只有把手能拖】整卡拖拽在触屏上会和页面滚动抢手势，所以手机上只有左上角
// grip 是把手（touch-action: none + pointer capture），拖到另一张卡上就与它换位。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music,
  Pencil,
  Plus,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import ImageLightbox from '@/app/components/ImageLightbox';
import {
  BLOCK_DEFS,
  BLOCK_KINDS,
  BLOCK_SIZES,
  GRID_COLUMNS,
  MAX_BLOCKS,
  MOBILE_HALF,
  findFreeSpot,
  mobileNeighbors,
  moveInMobileOrder,
  moveToOtherHalf,
  normalizeBlocks,
  normalizeConfig,
  projectMobile,
  rectsOverlap,
  sizeKey,
  swapBlockPositions,
  type BlockCatalog,
  type BlockKind,
  type BlockView,
  type ProfileBlock,
  type StoredBlock,
} from '@/lib/profile-blocks';

/** 桌面网格 gap。行高 = 列宽（方格），拖拽换算格距时只用这一个常量。 */
const GAP = 16;

const KIND_ICON: Record<BlockKind, typeof BookOpen> = {
  blog: BookOpen,
  image: ImageIcon,
  audio: Music,
  text: Type,
  link: Link2,
  stats: BarChart3,
  checkin: CalendarCheck,
};

type Draft = StoredBlock;

type Dialog =
  /** targetId 非空 = 「换一个」：替换那一块的指针，而不是新加一块。 */
  | { type: 'pick'; kind: 'blog' | 'image' | 'audio'; targetId?: string }
  | { type: 'field'; kind: 'text' | 'link' | 'image' | 'audio'; id: string | null; initial: Record<string, string> };

/** 内容来自「已有对象」的块 —— 目标不可用时唯一有意义的修复动作是「换一个」。 */
function isPickable(kind: BlockKind): kind is 'blog' | 'image' | 'audio' {
  return kind === 'blog' || kind === 'image' || kind === 'audio';
}

/** 有可编辑字段（标题 / 说明 / 正文）的块。 */
function isFieldEditable(kind: BlockKind): kind is 'text' | 'link' | 'image' | 'audio' {
  return kind === 'text' || kind === 'link' || kind === 'image' || kind === 'audio';
}

function genId(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
  ).replace(/[^a-z0-9]/g, '');
}

function stripView(b: ProfileBlock): Draft {
  return { id: b.id, kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h, config: b.config };
}

function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === 'string' ? v : '';
}

export default function ProfileBoard({
  profileId,
  blocks,
  catalog,
  isDefault,
  canEdit,
  isOwner,
  startEditing,
}: {
  profileId: string;
  blocks: ProfileBlock[];
  catalog: BlockCatalog | null;
  isDefault: boolean;
  canEdit: boolean;
  isOwner: boolean;
  startEditing: boolean;
}) {
  const router = useRouter();
  const gridRef = useRef<HTMLDivElement | null>(null);

  // 服务端给的是「上次保存的结果」。保存成功后要**立刻**显示新版，所以本地留一份；
  // PUT 响应里的 blocks 先写进来，props 一旦更新（router.replace 带回新 RSC）再覆盖。
  // 少了这一层，保存后得整页刷新才看得见自己的改动。
  const [boardBlocks, setBoardBlocks] = useState<ProfileBlock[]>(blocks);
  const [isDefaultLayout, setIsDefaultLayout] = useState(isDefault);

  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState<Draft[]>(() => blocks.map(stripView));
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** 点文字块打开的详情层。rect 是源卡片的位置，用来做 FLIP 的起始帧。 */
  const [detail, setDetail] = useState<{ rect: DOMRect; title: string; text: string } | null>(null);
  /** 正在播关闭动画：detail 先留着，面板反向 FLIP 回源卡片，动画结束才 unmount。 */
  const [detailClosing, setDetailClosing] = useState(false);

  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    w: number;
    h: number;
  } | null>(null);
  /** 手机把手拖拽：命中另一张卡的 id 存在 ref 里（state 只负责高亮）。 */
  const mobileDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const dragOverRef = useRef<string | null>(null);
  const detailPanelRef = useRef<HTMLDivElement | null>(null);
  const detailCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** 关闭动画期间挡住重复关闭（Esc 连按两下、点完背景又点关闭按钮）。 */
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  // ① 编辑态同步。点身份条「布置主页」只是同路由换 search：组件早已挂载，useState
  //    的初值不会再跑一遍 —— 不把 prop 变化同步进来，编辑栏就永远不出现。
  useEffect(() => {
    setEditing(startEditing);
    if (startEditing) setError(null);
  }, [startEditing]);

  // ② 服务端数据更新（保存后的 router.replace、别处导航）覆盖本地乐观副本。
  useEffect(() => {
    setBoardBlocks(blocks);
  }, [blocks]);

  useEffect(() => {
    setIsDefaultLayout(isDefault);
  }, [isDefault]);

  // ③ 非编辑态时，草稿跟随服务端数据。
  useEffect(() => {
    if (!editing) setDraft(boardBlocks.map(stripView));
  }, [boardBlocks, editing]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // 详情层：Esc 关闭、Tab 留在面板内、关闭后把焦点还给打开它的那张卡。
  useEffect(() => {
    if (!detail) return;
    const panel = detailPanelRef.current;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 锁滚动前先量滚动条宽度，并用 padding-right 抵掉 —— 直接 overflow:hidden 会让
    // 桌面端滚动条消失、正文横向跳一下（详情层是 fixed，跳的是背景）。
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) {
      const current = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + scrollbar}px`;
    }
    detailCloseRef.current?.focus();

    // FLIP：先把面板缩到源卡片的位置与大小，下一帧再放回自身 —— 用户看到的是
    // 「这张卡长大并移到屏幕中间」。scale 必须取等比（min），非等比会把文字压扁，
    // 1×1 卡片尤其明显。首帧面板是 opacity:0（写在 JSX 里），否则会先闪一下终态。
    let raf = 0;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = panel?.getBoundingClientRect() ?? null;
    if (panel && target && target.width > 0 && target.height > 0 && !reduce) {
      const sx = detail.rect.width / target.width;
      const sy = detail.rect.height / target.height;
      const dx = detail.rect.left + detail.rect.width / 2 - (target.left + target.width / 2);
      const dy = detail.rect.top + detail.rect.height / 2 - (target.top + target.height / 2);
      panel.style.transformOrigin = 'center center';
      panel.style.transform = `translate(${dx}px, ${dy}px) scale(${Math.min(sx, sy)})`;
      panel.style.opacity = '0.6';
      void panel.offsetWidth;
      panel.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s ease';
      raf = requestAnimationFrame(() => {
        panel.style.transform = 'none';
        panel.style.opacity = '1';
      });
    } else if (panel) {
      panel.style.opacity = '1';
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // 走同一个关闭函数：Esc 与点背景 / 关闭按钮的收尾必须是同一条路。
        closeDetail();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      restoreFocusRef.current?.focus();
    };
  }, [detail]);

  const draftById = useMemo(() => new Map(draft.map((b) => [b.id, b])), [draft]);

  // 「有没有还没保存的改动」—— 给工具栏一颗状态，避免用户以为拖完就已经生效了。
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(boardBlocks.map(stripView)),
    [draft, boardBlocks]
  );

  // 有未保存改动时离开页面要拦一下（只在编辑态）。beforeunload 是浏览器唯一
  // 会给确认框的钩子；移动端标签页被杀时它不触发，但那种情况本来就救不回来。
  useEffect(() => {
    if (!editing || !dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [editing, dirty]);

  /** 编辑态下的「能画什么」：优先用服务端解析好的 view，新加的块从清单里现拼。 */
  const viewOf = useCallback(
    (b: Draft): BlockView | null => {
      const existing = boardBlocks.find((x) => x.id === b.id);
      if (existing?.view) return existing.view;
      switch (b.kind) {
        case 'blog': {
          const c = catalog?.blogs.find((x) => x.id === cfgStr(b.config, 'blogId'));
          // 清单里没有正文摘要（那是服务端按当前正文现算的），刚挑中的文章先不显示摘要。
          return c
            ? { kind: 'blog', blogId: c.id, title: c.title, description: '', excerpt: '', date: null }
            : null;
        }
        case 'image': {
          const c = catalog?.images.find((x) => x.id === cfgStr(b.config, 'imageId'));
          return c
            ? {
                kind: 'image',
                imageId: c.id,
                url: c.url,
                alt: c.filename,
                caption: cfgStr(b.config, 'caption'),
              }
            : null;
        }
        case 'audio': {
          const c = catalog?.audios.find((x) => x.id === cfgStr(b.config, 'audioId'));
          return c
            ? {
                kind: 'audio',
                audioId: c.id,
                url: c.url,
                title: cfgStr(b.config, 'title') || c.filename,
              }
            : null;
        }
        case 'text': {
          const text = cfgStr(b.config, 'text');
          return text ? { kind: 'text', title: cfgStr(b.config, 'title'), text } : null;
        }
        case 'link': {
          const url = cfgStr(b.config, 'url');
          return url ? { kind: 'link', url, label: cfgStr(b.config, 'label') || url } : null;
        }
        // 统计 / 签到块没有 config 可填：新加的那一块必须立刻显示真数，
        // 否则编辑器里会先画成「还没填内容」+ 一个点了没反应的「编辑」按钮。
        case 'stats':
          return catalog
            ? { kind: 'stats', blogs: catalog.stats.blogs, likes: catalog.stats.likes, checkins: catalog.stats.checkins }
            : null;
        case 'checkin':
          return catalog ? { kind: 'checkin', days: catalog.stats.checkins } : null;
      }
    },
    [boardBlocks, catalog]
  );

  /** 编辑态画草稿；查看态只画「目标仍可用」的块（view 为 null 的整块不出现）。 */
  const list = useMemo(
    () => (editing ? draft : boardBlocks.filter((b) => b.view !== null).map(stripView)),
    [editing, draft, boardBlocks]
  );

  /**
   * 手机两列的落位。**与桌面同一份坐标投影出来**（见 profile-blocks 文件头）。
   * 不能交给 CSS 的 grid-auto-flow：浏览器流出来的位置 JS 读不到，网格线与拖拽
   * 命中就会各算一套，症状是「看着在这、拖到那却换了别的块」。
   */
  const projected = useMemo(() => projectMobile(list), [list]);
  const mobileRectOf = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    list.forEach((b, i) => map.set(b.id, projected[i]));
    return map;
  }, [list, projected]);

  /** 手机端读投影顺序，桌面读 (x,y)；两种都只从 list 来，画与操作共用一份。 */
  const visible = useMemo(
    () =>
      list.map((block) => ({
        block,
        mobile: mobileRectOf.get(block.id) ?? { x: 0, y: 0, w: Math.min(block.w, 2), h: block.h },
        view: editing ? viewOf(block) : boardBlocks.find((x) => x.id === block.id)?.view ?? null,
      })),
    [list, mobileRectOf, editing, viewOf, boardBlocks]
  );

  // 编辑态的背景网格：至少 3 行，并在内容下方再多留一行，让用户看到「还能往哪放」。
  const guideRows = useMemo(
    () => Math.max(3, draft.reduce((m, b) => Math.max(m, b.y + b.h), 0) + 1),
    [draft]
  );
  const guideRowsMobile = useMemo(
    () => Math.max(3, projected.reduce((m, r) => Math.max(m, r.y + r.h), 0) + 1),
    [projected]
  );

  // ── 拖拽 ──────────────────────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent<HTMLElement>, b: Draft) {
    if (!editing) return;
    const target = e.target as HTMLElement;
    if (target.closest('a,button,input,textarea,audio,select')) return;
    setSelected(b.id);
    if (isMobile) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingId(b.id);
    dragRef.current = {
      id: b.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: b.x,
      origY: b.y,
      w: b.w,
      h: b.h,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    const grid = gridRef.current;
    if (!d || !grid) return;
    const rect = grid.getBoundingClientRect();
    const cellW = (rect.width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    // 行高 = 列宽（方格），所以竖直方向也用 cellW 换算；写成 ROW_H 会与 CSS 漂开。
    const cellH = cellW + GAP;
    const dx = Math.round((e.clientX - d.startX) / cellW);
    const dy = Math.round((e.clientY - d.startY) / cellH);
    const x = Math.min(GRID_COLUMNS - d.w, Math.max(0, d.origX + dx));
    const y = Math.max(0, d.origY + dy);
    setDraft((prev) => {
      const me = prev.find((b) => b.id === d.id);
      if (!me || (me.x === x && me.y === y)) return prev;
      const others = prev.filter((b) => b.id !== d.id);
      if (others.some((o) => rectsOverlap({ x, y, w: d.w, h: d.h }, o))) return prev;
      return prev.map((b) => (b.id === d.id ? { ...b, x, y } : b));
    });
  }

  function onPointerUp() {
    dragRef.current = null;
    setDraggingId(null);
  }

  // ── 手机拖拽：只有左上角 grip 是把手 ──────────────────────────────────────
  //
  // 整卡拖在触屏上会和页面滚动抢手势（1×1 卡片又小），所以手机把拖动收进把手：
  // touch-action: none 让 pointermove 连续到达，pointer capture 让手指移出卡片也不丢；
  // 落点用 elementFromPoint 命中另一张卡，命中即与它交换位置。交换写的是**桌面坐标**，
  // 两端因此始终是同一份布局。

  function onGripPointerDown(e: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (!editing || !isMobile) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    e.currentTarget.setPointerCapture(e.pointerId);
    mobileDragRef.current = { id, pointerId: e.pointerId };
    dragOverRef.current = null;
    setDragOverId(null);
    setDraggingId(id);
  }

  function onGripPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = mobileDragRef.current;
    if (!d) return;
    // 防止拖动过程中浏览器顺带滚动页面（touch-action 只在 CSS 里保证起点）。
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const card = under?.closest<HTMLElement>('[data-bento-id]') ?? null;
    const over = card?.dataset.bentoId ?? null;
    const next = over && over !== d.id ? over : null;
    if (dragOverRef.current === next) return;
    dragOverRef.current = next;
    setDragOverId(next);
  }

  function endGripDrag(e?: React.PointerEvent<HTMLButtonElement>) {
    if (e?.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const d = mobileDragRef.current;
    const over = dragOverRef.current;
    mobileDragRef.current = null;
    dragOverRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
    if (!d || !over || over === d.id) return;
    // 换位会撞到第三块时 helper 返回 null —— 保持原样，别自作主张找空位。
    setDraft((prev) => swapBlockPositions(prev, d.id, over) ?? prev);
  }

  // ── 增删改 ────────────────────────────────────────────────────────────────
  function addBlock(kind: BlockKind, config: Record<string, unknown>) {
    if (draft.length >= MAX_BLOCKS) {
      setNotice(`一页最多放 ${MAX_BLOCKS} 块`);
      return;
    }
    const def = BLOCK_DEFS[kind];
    const { w, h } = def.defaultSize;
    const spot = findFreeSpot(draft, w, h);
    const id = genId();
    setDraft((prev) => [...prev, { id, kind, x: spot.x, y: spot.y, w, h, config }]);
    setSelected(id);
  }

  function removeBlock(id: string) {
    setDraft((prev) => prev.filter((b) => b.id !== id));
    if (selected === id) setSelected(null);
  }

  function applySize(id: string, w: number, h: number) {
    setDraft((prev) => {
      const me = prev.find((b) => b.id === id);
      if (!me) return prev;
      const others = prev.filter((b) => b.id !== id);
      let x = Math.min(me.x, GRID_COLUMNS - w);
      let y = me.y;
      if (others.some((o) => rectsOverlap({ x, y, w, h }, o))) {
        const spot = findFreeSpot(others, w, h);
        x = spot.x;
        y = spot.y;
      }
      return prev.map((b) => (b.id === id ? { ...b, x, y, w, h } : b));
    });
  }

  function moveBy(id: string, dx: number, dy: number) {
    setDraft((prev) => {
      const me = prev.find((b) => b.id === id);
      if (!me) return prev;
      const x = Math.min(GRID_COLUMNS - me.w, Math.max(0, me.x + dx));
      const y = Math.max(0, me.y + dy);
      const others = prev.filter((b) => b.id !== id);
      if (others.some((o) => rectsOverlap({ x, y, w: me.w, h: me.h }, o))) return prev;
      return prev.map((b) => (b.id === id ? { ...b, x, y } : b));
    });
  }

  /**
   * 手机端「上移 / 下移」：与**投影顺序**里的相邻块换位。
   * 两端是同一份坐标，所以换位后桌面位置也跟着变 —— 这是刻意的，不是 bug。
   */
  function moveInMobile(id: string, dir: -1 | 1) {
    const next = moveInMobileOrder(draft, id, dir);
    if (!next) {
      setNotice('这两块的位置换不开（会压到第三块）');
      return;
    }
    setDraft(next);
  }

  /** 手机端「左移 / 右移」：1 宽的块换到另一半；宽 2 是通栏，调用方把按钮置灰。 */
  function moveSide(id: string) {
    const next = moveToOtherHalf(draft, id);
    if (!next) {
      setNotice('那一侧没有空位');
      return;
    }
    setDraft(next);
  }

  // 上下移按钮的置灰判据必须与 moveInMobileOrder 一致（同列邻居 mobileNeighbors）。
  // 拿行优先序 mobileOrder 判断的话，左列最下面那块「下移」会一直亮着，按下去只弹提示。
  const mobileNav = useMemo(
    () => (selected ? mobileNeighbors(draft, selected) : { prev: null, next: null }),
    [draft, selected]
  );

  /** 查看态点文字块：从源卡片位置 FLIP 到屏幕中间的详情层。 */
  function openTextDetail(el: HTMLElement, title: string, text: string) {
    closingRef.current = false;
    setDetailClosing(false);
    const card = el.closest<HTMLElement>('.bento-card') ?? el;
    setDetail({ rect: card.getBoundingClientRect(), title, text });
  }

  /**
   * 关闭详情层：反向 FLIP 回源卡片，动画结束才 unmount。
   * 直接 setDetail(null) 会让面板原地消失 —— 打开时是「长大并移到中间」，收尾却是
   * 硬切，看起来像闪一下。Esc / 点背景 / 关闭按钮都走这里。
   */
  function closeDetail() {
    if (!detail || closingRef.current) return;
    const panel = detailPanelRef.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = panel?.getBoundingClientRect() ?? null;
    if (!panel || !target || target.width === 0 || target.height === 0 || reduce) {
      setDetail(null);
      return;
    }

    closingRef.current = true;
    setDetailClosing(true);

    const source = detail.rect;
    // 正向是等比放大，反向也必须等比缩小，否则文字会先被压扁再消失。
    const scale = Math.min(source.width / target.width, source.height / target.height);
    const dx = source.left + source.width / 2 - (target.left + target.width / 2);
    const dy = source.top + source.height / 2 - (target.top + target.height / 2);
    panel.style.transition = 'transform 0.22s cubic-bezier(0.4, 0, 1, 1), opacity 0.22s ease';
    panel.style.transformOrigin = 'center center';
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    panel.style.opacity = '0';

    let onEnd: ((ev: TransitionEvent) => void) | null = null;
    const finish = () => {
      if (!closingRef.current) return;
      closingRef.current = false;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (onEnd) panel.removeEventListener('transitionend', onEnd);
      setDetailClosing(false);
      setDetail(null);
    };
    onEnd = (ev) => {
      if (ev.target === panel && ev.propertyName === 'transform') finish();
    };
    panel.addEventListener('transitionend', onEnd);
    // 兜底：后台标签页 / 被其他动画打断时 transitionend 可能不来。
    closeTimerRef.current = window.setTimeout(finish, 340);
  }

  function startAdd(kind: BlockKind) {
    const def = BLOCK_DEFS[kind];
    if (def.picker) {
      const list = catalog?.[def.picker === 'blog' ? 'blogs' : def.picker === 'image' ? 'images' : 'audios'] ?? [];
      if (list.length === 0) {
        setNotice(def.emptyHint);
        return;
      }
      setDialog({ type: 'pick', kind: def.picker });
      return;
    }
    if (kind === 'text') {
      setDialog({ type: 'field', kind: 'text', id: null, initial: { title: '', text: '' } });
      return;
    }
    if (kind === 'link') {
      setDialog({ type: 'field', kind: 'link', id: null, initial: { label: '', url: '' } });
      return;
    }
    addBlock(kind, {});
  }

  /**
   * 「换一个」——目标已不可用（被删 / 降档 / 归档）时的修复路径。
   *
   * 之前这里只有一个 `编辑` 按钮，而 blog 块点它**什么都不发生**（它没有可填字段），
   * 用户只能删掉重加。现在按块类型走对应入口：指针类重新挑一个，文本类回字段弹窗。
   */
  function startRepick(b: Draft) {
    if (isPickable(b.kind)) {
      const def = BLOCK_DEFS[b.kind];
      const list = catalog?.[b.kind === 'blog' ? 'blogs' : b.kind === 'image' ? 'images' : 'audios'] ?? [];
      if (list.length === 0) {
        setNotice(def.emptyHint);
        return;
      }
      setDialog({ type: 'pick', kind: b.kind, targetId: b.id });
      return;
    }
    if (isFieldEditable(b.kind)) startEditField(b);
  }

  /** 把「换一个」挑中的指针写到既有块上（位置 / 尺寸不变）。 */
  function replacePointer(id: string, config: Record<string, unknown>) {
    setDraft((prev) => prev.map((b) => (b.id === id ? { ...b, config } : b)));
  }

  function startEditField(b: Draft) {
    if (b.kind === 'text' || b.kind === 'link') {
      setDialog({
        type: 'field',
        kind: b.kind,
        id: b.id,
        initial:
          b.kind === 'text'
            ? { title: cfgStr(b.config, 'title'), text: cfgStr(b.config, 'text') }
            : { label: cfgStr(b.config, 'label'), url: cfgStr(b.config, 'url') },
      });
      return;
    }
    if (b.kind === 'image') {
      setDialog({
        type: 'field',
        kind: 'image',
        id: b.id,
        initial: { caption: cfgStr(b.config, 'caption') },
      });
      return;
    }
    if (b.kind === 'audio') {
      setDialog({
        type: 'field',
        kind: 'audio',
        id: b.id,
        initial: { title: cfgStr(b.config, 'title') },
      });
    }
  }

  function submitField(kind: 'text' | 'link' | 'image' | 'audio', id: string | null, values: Record<string, string>) {
    if (kind === 'text') {
      const config = normalizeConfig('text', values);
      if (!config) {
        setNotice('写点内容再保存');
        return;
      }
      if (id) {
        setDraft((prev) => prev.map((b) => (b.id === id ? { ...b, config } : b)));
      } else {
        addBlock('text', config);
      }
    } else if (kind === 'link') {
      const config = normalizeConfig('link', values);
      if (!config) {
        setNotice('只支持 http / https 地址');
        return;
      }
      if (id) {
        setDraft((prev) => prev.map((b) => (b.id === id ? { ...b, config } : b)));
      } else {
        addBlock('link', config);
      }
    } else {
      if (!id) return;
      // 图片说明 / 音频标题：走同一个 normalizeConfig（服务端也是它）——
      // 客户端那份只做体验，但不能出现「本地看着存下了、刷新后变了」的差异。
      setDraft((prev) =>
        prev.map((b) => {
          if (b.id !== id) return b;
          const config = normalizeConfig(kind, { ...b.config, ...values });
          return config ? { ...b, config } : b;
        })
      );
    }
    setDialog(null);
  }

  async function save() {
    const parsed = normalizeBlocks(draft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/profile/blocks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: draft.map(({ id, kind, x, y, w, h, config }) => ({ id, kind, x, y, w, h, config })),
        }),
      });
      // apiOk 把 data 摊平在顶层（见 src/lib/format.ts）：字段是 json.blocks /
      // json.isDefault，不是 json.data.blocks。
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        count?: number;
        blocks?: ProfileBlock[];
        isDefault?: boolean;
      };
      if (!res.ok || json.code !== 200) {
        setError(json.message || '保存失败，请稍后再试');
        setSaving(false);
        return;
      }
      // 先吃响应里的新版：这一步让页面**不等整页刷新**就换成刚保存的布局。
      // 响应里没有 blocks（旧接口只回 count）就跳过，router.replace 带回的 RSC 会补上。
      if (Array.isArray(json.blocks)) {
        setBoardBlocks(json.blocks);
        setDraft(json.blocks.map(stripView));
      }
      if (typeof json.isDefault === 'boolean') setIsDefaultLayout(json.isDefault);
      setSaving(false);
      setEditing(false);
      setSelected(null);
      setNotice('已保存');
      // 地址栏的 `?edit=1` 也要去掉。**交给 router.replace**：裸 history.replaceState
      // 会让 Next 的路由树与地址栏不一致，之后 refresh 会按旧 URL 把 ?edit=1 写回去
      // （实测过）。同路由只换 search 的软导航不会丢客户端 state（「已保存」提示还在）。
      router.replace(`/u/${profileId}`, { scroll: false });
    } catch {
      setError('网络异常，请稍后再试');
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(boardBlocks.map(stripView));
    setEditing(false);
    setSelected(null);
    setError(null);
    // URL 必须跟着状态走，否则刷新会重新进入编辑态（`?edit=1` 还在地址栏）。
    router.replace(`/u/${profileId}`, { scroll: false });
  }

  const selectedBlock = selected ? draftById.get(selected) ?? null : null;

  // ── 空态 / 引导 ───────────────────────────────────────────────────────────
  // 渲染在正常树里（不是提前 return）：保存成功后 `editing` 先变 false、新布局
  // 已经由 PUT 响应写进 boardBlocks，这时如果整块提前 return，刚设的
  // 「已保存」提示会被一起丢掉 —— 用户看到页面闪成空态，以为没存上。
  const emptyState = !editing && visible.length === 0 ? (
    <section className="bento-empty">
      {isOwner ? (
        <>
          <h2 className="bento-empty__title">这里还没有东西</h2>
          <p className="bento-empty__text">
            挑几块放上来：文章、图片、文字、链接都可以。摆好后，访客看到的就是这一页。
          </p>
          {!canEdit && <p className="bento-empty__note">布置主页目前对核心用户开放。</p>}
        </>
      ) : (
        <p className="bento-empty__text">这个人还没有布置主页。</p>
      )}
    </section>
  ) : null;

  return (
    <div className={`bento${editing ? ' is-editing' : ''}`}>
      {editing && (
        <div className="bento-toolbar">
          <div className="bento-toolbar__hint">
            <GripVertical size={16} aria-hidden="true" />
            {isMobile
              ? '按住卡片左上角把手拖到另一张卡上可换位；点卡片选中后可调尺寸、左右或上下移动。'
              : '拖动卡片换位置；选中卡片后可调尺寸、改内容。'}
          </div>
          <span className={`bento-toolbar__dirty${dirty ? ' is-dirty' : ''}`}>
            {dirty ? '有未保存的修改' : '已保存'}
          </span>
          <div className="bento-toolbar__actions">
            <button type="button" className="bento-btn" onClick={cancel} disabled={saving}>
              放弃
            </button>
            <button type="button" className="bento-btn bento-btn--primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={16} className="bento-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              保存
            </button>
          </div>
        </div>
      )}

      {/* 默认布局的说明。**按钮只留在身份条那一颗**：同一页两处「布置主页」会让人
          不知道点哪个，而身份条那颗在编辑态会自己隐藏（page.tsx 的 canEdit && !startEditing）。 */}
      {isOwner && canEdit && isDefaultLayout && !editing && (
        <section className="bento-guide" aria-label="主页布置引导">
          <div className="bento-guide__text">
            <h2 className="bento-guide__title">这是你的名片</h2>
            <ol className="bento-guide__steps">
              <li>从文章、图片、文字、链接里挑几块</li>
              <li>拖到喜欢的位置，四档尺寸可调</li>
              <li>保存后，二维码和链接打开的访客看到的就是这一页</li>
            </ol>
          </div>
        </section>
      )}

      {error && (
        <p className="bento-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          {error}
        </p>
      )}
      {notice && (
        <p className="bento-notice" role="status">
          {notice}
        </p>
      )}

      {emptyState}

      {!emptyState && (
        <>
      <div
        className="bento-stage"
        style={{ '--rows': guideRows, '--rows-m': guideRowsMobile } as React.CSSProperties}
        // 点空白处取消选中：手机上卡片操作条是固定在底部的，没有这一下就退不出去。
        onPointerDown={(e) => {
          if (!editing) return;
          if (!(e.target as HTMLElement).closest('.bento-card')) setSelected(null);
        }}
      >
        {/* 网格线画在 gap 中线上（横竖连续），不是每格一圈虚线 —— 后者看起来像一堆
            独立的小框，反而看不清「跨格」这件事。桌面 3 竖线，手机 1 竖线。 */}
        {editing && (
          <div className="bento-guides" aria-hidden="true">
            {Array.from({ length: isMobile ? 1 : GRID_COLUMNS - 1 }).map((_, i) => (
              <span className="bento-guides__v" key={`v${i}`} style={{ '--i': i } as React.CSSProperties} />
            ))}
            {Array.from({ length: (isMobile ? guideRowsMobile : guideRows) - 1 }).map((_, i) => (
              <span className="bento-guides__h" key={`h${i}`} style={{ '--i': i } as React.CSSProperties} />
            ))}
          </div>
        )}
        <div className={`bento-grid${editing ? ' is-editing' : ''}`} ref={gridRef}>
          {visible.map(({ block, view, mobile }, index) => {
            const Icon = KIND_ICON[block.kind];
            const compact = block.w === 1 && block.h === 1;
            const short = block.h === 1;
            const tall = block.h >= 2;
            const wide = block.w === 2;
            const large = wide && block.h === 2;
            const unavailable = editing && !view;
            return (
              <article
                key={block.id}
                data-bento-id={block.id}
                className={[
                  'bento-card',
                  `bento-card--${block.kind}`,
                  compact ? 'is-compact' : '',
                  short ? 'is-short' : '',
                  tall ? 'is-tall' : '',
                  wide ? 'is-wide' : '',
                  large ? 'is-large' : '',
                  selected === block.id && editing ? 'is-selected' : '',
                  draggingId === block.id ? 'is-dragging' : '',
                  dragOverId === block.id ? 'is-drop-target' : '',
                  editing ? 'is-draggable' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={
                  {
                    '--gx': block.x,
                    '--gy': block.y,
                    '--gw': block.w,
                    '--gh': block.h,
                    // 手机落位用投影结果显式写死（见顶部注释），不用 grid-auto-flow。
                    '--mgx': mobile.x,
                    '--mgy': mobile.y,
                    '--mgw': mobile.w,
                    '--i': index,
                  } as React.CSSProperties
                }
                tabIndex={editing ? 0 : -1}
                aria-label={editing ? `第 ${index + 1} 块：${BLOCK_DEFS[block.kind].label}` : undefined}
                onPointerDown={(e) => onPointerDown(e, block)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={(e) => {
                  if (!editing) return;
                  // 方向键只在桌面有意义：手机的位置由投影决定，左右 / 上下走底部工具条。
                  if (!isMobile) {
                    if (e.key === 'ArrowLeft') { e.preventDefault(); moveBy(block.id, -1, 0); }
                    if (e.key === 'ArrowRight') { e.preventDefault(); moveBy(block.id, 1, 0); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(block.id, 0, -1); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(block.id, 0, 1); }
                  }
                  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeBlock(block.id); }
                }}
              >
                {/* 桌面：徽标只是「这块可拖」的提示，整卡就是把手。
                    手机：这是**唯一**的拖动把手（整卡拖会和页面滚动抢手势）。 */}
                {editing &&
                  (isMobile ? (
                    <button
                      type="button"
                      className="bento-card__grip bento-card__grip--drag"
                      aria-label="按住拖动，放到另一块上换位"
                      onPointerDown={(e) => onGripPointerDown(e, block.id)}
                      onPointerMove={onGripPointerMove}
                      onPointerUp={endGripDrag}
                      onPointerCancel={endGripDrag}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="bento-card__grip" aria-hidden="true">
                      <Icon size={14} />
                      <GripVertical size={14} />
                    </span>
                  ))}

                {unavailable ? (
                  <div className="bento-card__missing">
                    <span>{isPickable(block.kind) ? '这块内容已不可用' : '还没填内容'}</span>
                    {isPickable(block.kind) ? (
                      <button type="button" className="bento-mini" onClick={() => startRepick(block)}>
                        换一个
                      </button>
                    ) : isFieldEditable(block.kind) ? (
                      <button type="button" className="bento-mini" onClick={() => startRepick(block)}>
                        编辑
                      </button>
                    ) : null}
                  </div>
                ) : view ? (
                  <BlockBody
                    view={view}
                    compact={compact}
                    tall={tall}
                    interactive={!editing}
                    onOpenImage={(url) => setLightbox(url)}
                    onOpenText={(el) => {
                      // 只有文字块有详情层：它可能是 200 字，卡片里永远看不全。
                      if (view.kind === 'text') openTextDetail(el, view.title, view.text);
                    }}
                  />
                ) : null}

                {/* 手机端不往卡片里塞操作：1×1 的卡塞不下 6 颗按钮，而且按钮会盖住
                    内容。选中后的操作统一走底部固定条（见 .bento-dock）。 */}
                {editing && !isMobile && selected === block.id && (
                  <div className="bento-card__tools">
                    {BLOCK_SIZES.map((s) => (
                      <button
                        key={sizeKey(s.w, s.h)}
                        type="button"
                        className={`bento-size${s.w === block.w && s.h === block.h ? ' is-active' : ''}`}
                        onClick={() => applySize(block.id, s.w, s.h)}
                        title={`${s.label}（${s.w}×${s.h}）`}
                      >
                        {s.w}×{s.h}
                      </button>
                    ))}
                    {isFieldEditable(block.kind) && (
                      <button type="button" className="bento-mini" onClick={() => startEditField(block)}>
                        编辑
                      </button>
                    )}
                    <button type="button" className="bento-mini bento-mini--danger" onClick={() => removeBlock(block.id)} aria-label="删除这块">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </article>
            );
          })}

          {editing && draft.length === 0 && (
            <div
              className="bento-card bento-card--ghost"
              style={
                {
                  '--gx': 0,
                  '--gy': 0,
                  '--gw': 2,
                  '--gh': 1,
                  '--mgx': 0,
                  '--mgy': 0,
                  '--mgw': 2,
                } as React.CSSProperties
              }
            >
              <div className="bento-card__missing">
                <span>{isMobile ? '从下方工具条加一块开始' : '从下面挑一块开始'}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 桌面：检查器 + 加块面板都在正常文档流里（面板吸底，滚到底就能完整操作）。 */}
      {editing && !isMobile && selectedBlock && (
        <div className="bento-inspector">
          <span className="bento-inspector__label">
            已选：{BLOCK_DEFS[selectedBlock.kind].label}（{selectedBlock.w}×{selectedBlock.h}）
          </span>
          <div className="bento-inspector__sizes">
            {BLOCK_SIZES.map((s) => (
              <button
                key={sizeKey(s.w, s.h)}
                type="button"
                className={`bento-size${s.w === selectedBlock.w && s.h === selectedBlock.h ? ' is-active' : ''}`}
                onClick={() => applySize(selectedBlock.id, s.w, s.h)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="bento-inspector__hint">方向键可微调位置，Delete 删除</span>
        </div>
      )}

      {editing && !isMobile && <Palette draftCount={draft.length} onAdd={startAdd} />}

      {/* 手机：底部固定工具条。没选中时是「加一块」，选中后换成那一块的操作 ——
          同一块屏幕空间只回答一个问题，也避免 1×1 卡片里塞满按钮。 */}
      {editing && isMobile && (
        <div className="bento-dock" role="region" aria-label="主页编辑工具">
          {selectedBlock ? (
            <>
              <div className="bento-dock__head">
                <span className="bento-dock__label">
                  已选：{BLOCK_DEFS[selectedBlock.kind].label}
                </span>
                <button type="button" className="bento-dock__done" onClick={() => setSelected(null)}>
                  <X size={16} aria-hidden="true" />
                  完成
                </button>
              </div>
              <div className="bento-dock__row">
                {BLOCK_SIZES.map((s) => (
                  <button
                    key={sizeKey(s.w, s.h)}
                    type="button"
                    className={`bento-size bento-size--lg${s.w === selectedBlock.w && s.h === selectedBlock.h ? ' is-active' : ''}`}
                    onClick={() => applySize(selectedBlock.id, s.w, s.h)}
                    aria-label={`${s.label}尺寸（${s.w}×${s.h}）`}
                  >
                    {s.label}
                  </button>
                ))}
                <span className="bento-dock__rowgap" aria-hidden="true" />
                {/* 左移 / 右移改的是桌面 x（换到另一半），宽 2 的块两头通栏、没有可移的方向。
                    已经在左半的块不能再「左移」，所以同侧那颗置灰，避免按了没反应。 */}
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveSide(selectedBlock.id)}
                  disabled={selectedBlock.w !== 1 || selectedBlock.x < MOBILE_HALF}
                  aria-label="移到左边一半"
                  title="移到左边一半"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveSide(selectedBlock.id)}
                  disabled={selectedBlock.w !== 1 || selectedBlock.x >= MOBILE_HALF}
                  aria-label="移到右边一半"
                  title="移到右边一半"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveInMobile(selectedBlock.id, -1)}
                  disabled={!mobileNav.prev}
                  aria-label="上移一块"
                >
                  <ChevronUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveInMobile(selectedBlock.id, 1)}
                  disabled={!mobileNav.next}
                  aria-label="下移一块"
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {isFieldEditable(selectedBlock.kind) && (
                  <button type="button" className="bento-size bento-size--lg" onClick={() => startEditField(selectedBlock)}>
                    <Pencil size={15} aria-hidden="true" />
                    <span className="visually-hidden">编辑内容</span>
                  </button>
                )}
                <button
                  type="button"
                  className="bento-size bento-size--lg bento-size--danger"
                  onClick={() => removeBlock(selectedBlock.id)}
                  aria-label="删除这块"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <Palette draftCount={draft.length} onAdd={startAdd} compact />
          )}
        </div>
      )}
        </>
      )}

      {dialog?.type === 'pick' && catalog && (
        <PickerDialog
          kind={dialog.kind}
          catalog={catalog}
          onClose={() => setDialog(null)}
          onPick={(config) => {
            // 「换一个」复用同一个清单弹窗：目标是替换既有块（位置尺寸不变），
            // 不是再加一块 —— 否则用户点了「换一个」会得到第二块。
            if (dialog.targetId) replacePointer(dialog.targetId, config);
            else addBlock(dialog.kind, config);
            setDialog(null);
          }}
        />
      )}

      {dialog?.type === 'field' && (
        <FieldDialog
          kind={dialog.kind}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSubmit={(values) => submitField(dialog.kind, dialog.id, values)}
        />
      )}

      {lightbox && <ImageLightbox src={lightbox} alt="主页图片" onClose={() => setLightbox(null)} />}

      {/* 文字块详情：从源卡片位置 FLIP 到屏幕中间（起始帧在 effect 里写成 inline
          transform）。role/aria-modal 与焦点管理是必需的 —— 它是盖住整页的模态层。 */}
      {detail && (
        <div
          className={`bento-detail${detailClosing ? ' is-closing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="bento-detail-title"
        >
          <div className="bento-detail__backdrop" aria-hidden="true" onPointerDown={closeDetail} />
          <div className="bento-detail__panel" ref={detailPanelRef} tabIndex={-1} style={{ opacity: 0 }}>
            <div className="bento-detail__head">
              <h2 className="bento-detail__title" id="bento-detail-title">
                {detail.title || '文字'}
              </h2>
              <button
                type="button"
                className="bento-mini"
                ref={detailCloseRef}
                onClick={closeDetail}
                aria-label="关闭"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="bento-detail__text">{detail.text}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 加块面板（桌面在流内吸底，手机在固定工具条里横滚）──────────────────────────

function Palette({
  draftCount,
  onAdd,
  compact,
}: {
  draftCount: number;
  onAdd: (kind: BlockKind) => void;
  /** 手机工具条里：单行横滚，省出纵向空间给卡片。 */
  compact?: boolean;
}) {
  return (
    <div className={`bento-palette${compact ? ' bento-palette--compact' : ''}`}>
      <span className="bento-palette__title">
        <Plus size={16} aria-hidden="true" />
        加一块
      </span>
      <div className="bento-palette__items">
        {BLOCK_KINDS.map((kind) => {
          const def = BLOCK_DEFS[kind];
          const Icon = KIND_ICON[kind];
          return (
            <button
              key={kind}
              type="button"
              className="bento-palette__item"
              onClick={() => onAdd(kind)}
              title={def.hint}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{def.label}</span>
            </button>
          );
        })}
      </div>
      <span className="bento-palette__free">
        {draftCount}/{MAX_BLOCKS} 块
      </span>
    </div>
  );
}

// ── 卡片内容 ────────────────────────────────────────────────────────────────

function BlockBody({
  view,
  compact,
  tall,
  interactive,
  onOpenImage,
  onOpenText,
}: {
  view: BlockView;
  compact: boolean;
  /** h≥2：纵向有空间，文章显示正文摘要（见 profile-blocks 的 view.excerpt）。 */
  tall: boolean;
  interactive: boolean;
  onOpenImage: (url: string) => void;
  onOpenText: (el: HTMLElement) => void;
}) {
  switch (view.kind) {
    case 'blog': {
      const inner = (
        <>
          <span className="bento-blog__kicker">
            <BookOpen size={14} aria-hidden="true" />
            文章
          </span>
          <span className="bento-blog__title">{view.title}</span>
          {/* 描述与摘要都画：有的文章只有描述、正文很短，高卡片只画摘要会剩一大片
              空白。行数由 CSS 按档位 clamp（高卡描述 2 行、摘要 4/7 行）。 */}
          {!compact && view.description ? (
            <span className="bento-blog__desc">{view.description}</span>
          ) : null}
          {tall && view.excerpt ? <span className="bento-blog__excerpt">{view.excerpt}</span> : null}
          <span className="bento-blog__meta">
            {view.date && (
              <time className="bento-blog__date numeric" dateTime={view.date}>
                {view.date}
              </time>
            )}
            <ArrowUpRight size={14} aria-hidden="true" />
          </span>
        </>
      );
      // ★ 编辑态里不能是 <Link>：点一下会跳去文章详情，用户想选中的那块永远选不中。
      return interactive ? (
        <Link className="bento-card__body bento-blog" href={`/blog/${view.blogId}`}>
          {inner}
        </Link>
      ) : (
        <div className="bento-card__body bento-blog">{inner}</div>
      );
    }
    case 'image': {
      const inner = (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="bento-image__img"
            src={view.url}
            alt={view.alt}
            loading="lazy"
            draggable={false}
            // 浏览器原生图片拖拽会抢走 pointer 事件，卡片就再也拖不动了。
            onDragStart={(e) => e.preventDefault()}
          />
          {!compact && view.caption && <span className="bento-image__caption">{view.caption}</span>}
        </>
      );
      return interactive ? (
        <button type="button" className="bento-card__body bento-image" onClick={() => onOpenImage(view.url)}>
          {inner}
        </button>
      ) : (
        <div className="bento-card__body bento-image is-static">{inner}</div>
      );
    }
    case 'audio':
      return (
        <div className="bento-card__body bento-audio">
          <span className="bento-audio__title">
            <Music size={14} aria-hidden="true" />
            {view.title}
          </span>
          {/* 编辑态不给播放器控件：控件会吃掉 pointerdown，卡片就拖不动了 */}
          {interactive ? (
            <audio className="bento-audio__el" controls preload="none" src={view.url} />
          ) : (
            <span className="bento-audio__placeholder">音频</span>
          )}
        </div>
      );
    case 'text': {
      const inner = (
        <>
          {view.title && <span className="bento-text__title">{view.title}</span>}
          {/* 查看态整块是 <button>，里面只能用 phrasing 内容，所以正文用 span 不用 p。 */}
          <span className="bento-text__body">{view.text}</span>
        </>
      );
      // 查看态点开详情层：卡片里最多 6 行，200 字看不全。编辑态仍是可拖的普通块。
      return interactive ? (
        <button
          type="button"
          className="bento-card__body bento-text is-tappable"
          onClick={(e) => onOpenText(e.currentTarget)}
        >
          {inner}
        </button>
      ) : (
        <div className="bento-card__body bento-text">{inner}</div>
      );
    }
    case 'link': {
      const inner = (
        <>
          <ExternalLink size={16} aria-hidden="true" />
          <span className="bento-link__label">{view.label}</span>
        </>
      );
      return interactive ? (
        <a className="bento-card__body bento-link" href={view.url} target="_blank" rel="noopener noreferrer nofollow">
          {inner}
        </a>
      ) : (
        <div className="bento-card__body bento-link is-static">{inner}</div>
      );
    }
    case 'stats':
      return (
        <div className="bento-card__body bento-stats">
          <span className="bento-stats__item">
            <span className="bento-stats__num numeric">{view.blogs}</span>
            {/* 数的是「对外可读」（public + link），不是只有 public */}
            <span className="bento-stats__label">对外文章</span>
          </span>
          <span className="bento-stats__item">
            <span className="bento-stats__num numeric">{view.likes}</span>
            <span className="bento-stats__label">获赞</span>
          </span>
          <span className="bento-stats__item">
            <span className="bento-stats__num numeric">{view.checkins}</span>
            <span className="bento-stats__label">签到天数</span>
          </span>
        </div>
      );
    case 'checkin':
      return (
        <div className="bento-card__body bento-checkin">
          <CalendarCheck size={18} aria-hidden="true" />
          <span className="bento-checkin__num numeric">{view.days}</span>
          {/* DailyCheckIn 只有「每天一行」，没有 streak 列 —— 这里只能是累计。 */}
          <span className="bento-checkin__label">天累计签到</span>
        </div>
      );
  }
}

// ── 弹窗：从已有对象里挑 ─────────────────────────────────────────────────────

function PickerDialog({
  kind,
  catalog,
  onClose,
  onPick,
}: {
  kind: 'blog' | 'image' | 'audio';
  catalog: BlockCatalog;
  onClose: () => void;
  onPick: (config: Record<string, unknown>) => void;
}) {
  return (
    <div className="bento-modal" role="dialog" aria-modal="true" aria-label="选择内容">
      <div className="bento-modal__box">
        <div className="bento-modal__head">
          <h3>{kind === 'blog' ? '挑一篇文章' : kind === 'image' ? '挑一张图片' : '挑一段音频'}</h3>
          <button type="button" className="bento-mini" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="bento-modal__body">
          {kind === 'blog' && (
            <ul className="bento-pick-list">
              {catalog.blogs.map((b) => (
                <li key={b.id}>
                  <button type="button" className="bento-pick" onClick={() => onPick({ blogId: b.id })}>
                    <span className="bento-pick__name">{b.title}</span>
                    <span className="bento-pick__meta">{b.visibility === 'public' ? '公开' : '凭链接可读'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {kind === 'image' && (
            <div className="bento-pick-grid">
              {catalog.images.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="bento-pick-img"
                  onClick={() => onPick({ imageId: i.id, caption: '' })}
                  title={i.filename}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={i.url}
                    alt={i.filename}
                    loading="lazy"
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                  />
                </button>
              ))}
            </div>
          )}
          {kind === 'audio' && (
            <ul className="bento-pick-list">
              {catalog.audios.map((a) => (
                <li key={a.id}>
                  <button type="button" className="bento-pick" onClick={() => onPick({ audioId: a.id, title: '' })}>
                    <span className="bento-pick__name">{a.filename}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 弹窗：编辑文字 / 链接 / 图片说明 / 音频标题 ────────────────────────────────

function FieldDialog({
  kind,
  initial,
  onClose,
  onSubmit,
}: {
  kind: 'text' | 'link' | 'image' | 'audio';
  initial: Record<string, string>;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [text, setText] = useState(initial.text ?? '');
  const [label, setLabel] = useState(initial.label ?? '');
  const [url, setUrl] = useState(initial.url ?? '');
  const [caption, setCaption] = useState(initial.caption ?? '');

  const head =
    kind === 'text' ? '写一段文字' : kind === 'link' ? '加一个链接' : kind === 'image' ? '图片说明' : '音频标题';

  return (
    <div className="bento-modal" role="dialog" aria-modal="true" aria-label={head}>
      <div className="bento-modal__box">
        <div className="bento-modal__head">
          <h3>{head}</h3>
          <button type="button" className="bento-mini" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="bento-modal__body">
          {kind === 'text' && (
            <>
              <label className="bento-field">
                <span>小标题（可留空）</span>
                <input className="form-control" value={title} maxLength={24} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="bento-field">
                <span>正文（纯文本，最多 200 字）</span>
                <textarea
                  className="form-control"
                  rows={5}
                  value={text}
                  maxLength={200}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="写点什么"
                />
              </label>
            </>
          )}
          {kind === 'link' && (
            <>
              <label className="bento-field">
                <span>地址（http / https）</span>
                <input className="form-control" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              </label>
              <label className="bento-field">
                <span>显示文字（可留空，默认用域名）</span>
                <input className="form-control" value={label} maxLength={24} onChange={(e) => setLabel(e.target.value)} />
              </label>
            </>
          )}
          {kind === 'image' && (
            <label className="bento-field">
              <span>说明（可留空）</span>
              <input className="form-control" value={caption} maxLength={40} onChange={(e) => setCaption(e.target.value)} />
            </label>
          )}
          {kind === 'audio' && (
            <label className="bento-field">
              <span>标题（可留空）</span>
              <input className="form-control" value={title} maxLength={24} onChange={(e) => setTitle(e.target.value)} />
            </label>
          )}
        </div>
        <div className="bento-modal__foot">
          <button type="button" className="bento-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="bento-btn bento-btn--primary"
            onClick={() =>
              onSubmit(
                kind === 'text'
                  ? { title, text }
                  : kind === 'link'
                    ? { label, url }
                    : kind === 'image'
                      ? { caption }
                      : { title }
              )
            }
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

