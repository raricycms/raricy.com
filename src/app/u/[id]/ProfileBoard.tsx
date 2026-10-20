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
// 【两种摆放模型，别混】桌面是 4 列自由网格（位置 = x/y，拖动摆放）；手机是两列
// 流式（忽略 x/y，按**数组顺序**排，存在 profile_blocks.sort 里）。所以手机上换顺序
// 只改数组下标，**不动桌面坐标** —— 反过来会把桌面精心留的空白一起改掉。
// 手机端不支持拖动（流式布局里「拖到哪」没有意义），改用选中后的「上移 / 下移」。
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
  findFreeSpot,
  normalizeBlocks,
  normalizeConfig,
  rectsOverlap,
  sizeKey,
  type BlockCatalog,
  type BlockKind,
  type BlockView,
  type ProfileBlock,
  type StoredBlock,
} from '@/lib/profile-blocks';

const ROW_H = 132;
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

  // 非编辑态时，服务端刷新（保存后 router.refresh）要把新数据同步进草稿。
  useEffect(() => {
    if (!editing) setDraft(blocks.map(stripView));
  }, [blocks, editing]);

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

  const draftById = useMemo(() => new Map(draft.map((b) => [b.id, b])), [draft]);

  // 「有没有还没保存的改动」—— 给工具栏一颗状态，避免用户以为拖完就已经生效了。
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(blocks.map(stripView)),
    [draft, blocks]
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

  /**
   * 只改地址栏、不触发导航。
   *
   * ⚠️ **必须把 `window.history.state` 原样传回去**：Next App Router 把当前路由树
   * 挂在 history.state 里。这里传 `{}` 会把它抹掉，随后 `router.refresh()` 拿不到
   * 正确的树 —— 症状是「保存成功、刷新回来的却是上一次的数据」（实测过：连存两次，
   * 页面总落后一版，reload 一下又对了）。
   */
  function syncUrl(url: string) {
    window.history.replaceState(window.history.state, '', url);
  }

  /** 编辑态下的「能画什么」：优先用服务端解析好的 view，新加的块从清单里现拼。 */
  const viewOf = useCallback(
    (b: Draft): BlockView | null => {
      const existing = blocks.find((x) => x.id === b.id);
      if (existing?.view) return existing.view;
      switch (b.kind) {
        case 'blog': {
          const c = catalog?.blogs.find((x) => x.id === cfgStr(b.config, 'blogId'));
          return c ? { kind: 'blog', blogId: c.id, title: c.title, description: '', date: null } : null;
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
    [blocks, catalog]
  );

  /** 手机端顺序 = 数组下标（桌面位置仍由 x/y 决定）。只改顺序，不动坐标。 */
  const visible = useMemo(() => {
    const list = editing ? draft : blocks.filter((b) => b.view !== null).map(stripView);
    return list.map((block) => ({
      block,
      view: editing ? viewOf(block) : blocks.find((x) => x.id === block.id)?.view ?? null,
    }));
  }, [editing, draft, blocks, viewOf]);

  // 编辑态的背景格：至少 3 行，并在内容下方再多留一行，让用户看到「还能往哪放」。
  const guideRows = useMemo(() => {
    const bottom = draft.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    return Math.max(3, bottom + 1);
  }, [draft]);

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
    const cellH = ROW_H + GAP;
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
   * 手机端的上移 / 下移：只交换数组里相邻两项。
   * 保存时服务端按数组下标写 `sort`，所以这一操作**不会碰任何块的 x/y** ——
   * 桌面布局保持原样（迁移 32 头部讲了为什么必须是两套）。
   */
  function moveInOrder(id: string, dir: -1 | 1) {
    setDraft((prev) => {
      const i = prev.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  const orderIndex = selected ? draft.findIndex((b) => b.id === selected) : -1;

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
      const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
      if (!res.ok || json.code !== 200) {
        setError(json.message || '保存失败，请稍后再试');
        setSaving(false);
        return;
      }
      setSaving(false);
      setEditing(false);
      setSelected(null);
      setNotice('已保存');
      // 保存成功后既要把地址栏的 `?edit=1` 去掉，也要让服务端把新布局渲染回来。
      // **两件事都交给 router.replace**：
      //   · 先裸 `history.replaceState` 改地址栏、再 `router.refresh()` 的话，
      //     refresh 会按路由树里的旧 URL 把地址栏写回去（实测：URL 又变回 ?edit=1）；
      //   · 只 refresh 不 replace 则 `?edit=1` 一直留在地址栏，刷新会重进编辑态。
      // 同路由、只换 searchParams 的软导航不会丢客户端 state（「已保存」提示还在）。
      router.replace(`/u/${profileId}`, { scroll: false });
    } catch {
      setError('网络异常，请稍后再试');
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(blocks.map(stripView));
    setEditing(false);
    setSelected(null);
    setError(null);
    if (window.location.search.includes('edit=1')) {
      syncUrl(`/u/${profileId}`);
    }
  }

  function beginEditing() {
    setEditing(true);
    setError(null);
    syncUrl(`/u/${profileId}?edit=1`);
  }

  const selectedBlock = selected ? draftById.get(selected) ?? null : null;

  // ── 空态 / 引导 ───────────────────────────────────────────────────────────
  // 渲染在正常树里（不是提前 return）：保存成功后 `editing` 先变 false、新的
  // blocks 还没随 router.refresh 回来，这时如果整块提前 return，刚设的
  // 「已保存」提示会被一起丢掉 —— 用户看到页面闪成空态，以为没存上。
  const emptyState = !editing && visible.length === 0 ? (
    <section className="bento-empty">
      {isOwner ? (
        <>
          <h2 className="bento-empty__title">这里还没有东西</h2>
          <p className="bento-empty__text">
            挑几块放上来：文章、图片、文字、链接都可以。摆好后，访客看到的就是这一页。
          </p>
          {canEdit ? (
            <button type="button" className="bento-btn bento-btn--primary" onClick={beginEditing}>
              <Plus size={18} aria-hidden="true" />
              开始布置
            </button>
          ) : (
            <p className="bento-empty__note">布置主页目前对核心用户开放。</p>
          )}
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
            {isMobile ? <Pencil size={16} aria-hidden="true" /> : <GripVertical size={16} aria-hidden="true" />}
            {isMobile
              ? '点卡片选中后可调尺寸、上下移动、删除；加块在下方工具条。'
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

      {isOwner && canEdit && isDefault && !editing && (
        <section className="bento-guide" aria-label="主页布置引导">
          <div className="bento-guide__text">
            <h2 className="bento-guide__title">这是你的名片</h2>
            <ol className="bento-guide__steps">
              <li>从文章、图片、文字、链接里挑几块</li>
              <li>拖到喜欢的位置，四档尺寸可调</li>
              <li>保存后，二维码和链接打开的访客看到的就是这一页</li>
            </ol>
          </div>
          {canEdit && (
            <button type="button" className="bento-btn bento-btn--primary" onClick={beginEditing}>
              <Pencil size={16} aria-hidden="true" />
              布置主页
            </button>
          )}
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
        style={{ '--rows': guideRows } as React.CSSProperties}
        // 点空白处取消选中：手机上卡片操作条是固定在底部的，没有这一下就退不出去。
        onPointerDown={(e) => {
          if (!editing) return;
          if (!(e.target as HTMLElement).closest('.bento-card')) setSelected(null);
        }}
      >
        {/* 背景格只在桌面画：手机是两列流式，坐标与格位对不上，画出来是误导。 */}
        {editing && !isMobile && (
          <div className="bento-guides" aria-hidden="true">
            {Array.from({ length: guideRows * 4 }).map((_, i) => (
              <span className="bento-guides__cell" key={i} />
            ))}
          </div>
        )}
        <div className={`bento-grid${editing ? ' is-editing' : ''}`} ref={gridRef}>
          {visible.map(({ block, view }, index) => {
            const Icon = KIND_ICON[block.kind];
            const compact = block.w === 1 && block.h === 1;
            const short = block.h === 1;
            const unavailable = editing && !view;
            return (
              <article
                key={block.id}
                className={[
                  'bento-card',
                  `bento-card--${block.kind}`,
                  compact ? 'is-compact' : '',
                  short ? 'is-short' : '',
                  selected === block.id && editing ? 'is-selected' : '',
                  draggingId === block.id ? 'is-dragging' : '',
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
                    '--gw-m': Math.min(block.w, 2),
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
                  if (e.key === 'ArrowLeft') { e.preventDefault(); moveBy(block.id, -1, 0); }
                  if (e.key === 'ArrowRight') { e.preventDefault(); moveBy(block.id, 1, 0); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(block.id, 0, -1); }
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(block.id, 0, 1); }
                  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeBlock(block.id); }
                }}
              >
                {editing && !isMobile && (
                  <span className="bento-card__grip" aria-hidden="true">
                    <Icon size={14} />
                    <GripVertical size={14} />
                  </span>
                )}

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
                    interactive={!editing}
                    onOpenImage={(url) => setLightbox(url)}
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
            <div className="bento-card bento-card--ghost" style={{ '--gx': 0, '--gy': 0, '--gw': 2, '--gh': 1, '--gw-m': 2 } as React.CSSProperties}>
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
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveInOrder(selectedBlock.id, -1)}
                  disabled={orderIndex <= 0}
                  aria-label="上移一块"
                >
                  <ChevronUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="bento-size bento-size--lg"
                  onClick={() => moveInOrder(selectedBlock.id, 1)}
                  disabled={orderIndex >= draft.length - 1}
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
  interactive,
  onOpenImage,
}: {
  view: BlockView;
  compact: boolean;
  interactive: boolean;
  onOpenImage: (url: string) => void;
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
          {!compact && view.description && <span className="bento-blog__desc">{view.description}</span>}
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
          <img className="bento-image__img" src={view.url} alt={view.alt} loading="lazy" />
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
    case 'text':
      return (
        <div className="bento-card__body bento-text">
          {view.title && <span className="bento-text__title">{view.title}</span>}
          <p className="bento-text__body">{view.text}</p>
        </div>
      );
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
                  <img src={i.url} alt={i.filename} loading="lazy" />
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

