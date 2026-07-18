'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PhotoWall — 照片墙客户端交互组件
//   忠实移植自 app/templates/photowall/wall.html 的内联 vanilla JS：
//   视口平移/滚轮缩放、条目拖拽（pointer events）、旋转手柄、缩放手柄、
//   置于顶层（bring-to-front）、贴照片选图器、详情浮层、底部列表。
//
//   与原版差异（受当前 Next API 端点约束）：
//   - 位置/旋转/缩放仅在指针释放时通过 PATCH /api/photowall/:id 持久化（拖拽中不发请求）。
//   - “上移一层 / 下移一层”与相邻层逐层交换 z_index（对齐 Flask move-layer 语义），
//     Next 无 move-layer 端点，用两次 PATCH { z_index } 互换实现。
//   - 未登录用户可查看/平移/缩放/查看详情，但不能拖拽/旋转/缩放/贴图。
//
//   实现要点：用 React ref + pointer events，不做全局 DOM id 查找。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// 与 Flask / photowall-service 常量对齐
const WALL_WIDTH = 4000;
const WALL_HEIGHT = 3000;
const ITEM_DEFAULT_W = 280;
const ITEM_DEFAULT_H = 210;
const PAN_THRESHOLD = 3;

interface Item {
  id: string;
  imageId: string;
  x: number;
  y: number;
  rotation: number;
  zIndex: number;
  scale: number;
  authorName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
}

interface PickerImage {
  id: string;
  filename: string;
  url: string;
}

// GET /api/photowall 的 snake_case 条目
interface ApiItem {
  id: string;
  image_id: string;
  x: number;
  y: number;
  rotation: number;
  z_index: number;
  scale: number;
  author_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  url: string;
}

function fromApi(it: ApiItem): Item {
  return {
    id: it.id,
    imageId: it.image_id,
    x: it.x,
    y: it.y,
    rotation: it.rotation,
    zIndex: it.z_index,
    scale: it.scale,
    authorName: it.author_name,
    createdAt: it.created_at,
    updatedAt: it.updated_at,
    url: it.url,
  };
}

function toast(msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

type DragMode = 'pan' | 'move' | 'rotate' | 'scale';

interface Interaction {
  mode: DragMode | null;
  itemId: string | null;
  startClient: { x: number; y: number };
  // pan: 起始视口偏移；move: 起始条目坐标
  startOffset: { x: number; y: number };
  startValue: number; // rotate: 起始角度；scale: 起始缩放
  center: { x: number; y: number }; // 旋转/缩放中心（画布坐标）
  startCanvas: { x: number; y: number }; // 指针按下时的画布坐标
  panMoved: boolean;
  // 拖拽过程中的实时值（释放时提交 + PATCH）
  work: { x: number; y: number; rotation: number; scale: number };
}

export default function PhotoWall() {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<'my-images' | 'upload-new'>('my-images');
  const [pickerImages, setPickerImages] = useState<PickerImage[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // 详情“上传时间”是否切换为 updated_at（拖拽开始后置 true，对齐 Flask updateDetailFields）
  const [detailUpdated, setDetailUpdated] = useState(false);

  // DOM refs
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const itemEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  // 底部列表条目元素 + 上一次位置（FLIP 平滑重排用）
  const listItemEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const prevListTops = useRef<Map<string, number>>(new Map());

  // 交互态（不触发 render）
  const view = useRef({ panX: 0, panY: 0, zoom: 0.35 });
  const ix = useRef<Interaction>({
    mode: null,
    itemId: null,
    startClient: { x: 0, y: 0 },
    startOffset: { x: 0, y: 0 },
    startValue: 0,
    center: { x: 0, y: 0 },
    startCanvas: { x: 0, y: 0 },
    panMoved: false,
    work: { x: 0, y: 0, rotation: 0, scale: 1 },
  });
  const rafRef = useRef<number | null>(null);

  // 供事件处理读取最新值的镜像 ref
  const itemsRef = useRef<Item[]>(items);
  itemsRef.current = items;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // ── 视口变换 ──
  const applyViewport = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (canvas) {
        const { panX, panY, zoom } = view.current;
        canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      }
      rafRef.current = null;
    });
  }, []);

  const resetView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const pad = vw < 768 ? 8 : 40;
    const zoom = Math.min((vw - pad * 2) / WALL_WIDTH, (vh - pad * 2) / WALL_HEIGHT);
    view.current.zoom = zoom;
    view.current.panX = (vw - WALL_WIDTH * zoom) / 2;
    view.current.panY = (vh - WALL_HEIGHT * zoom) / 2;
    applyViewport();
  }, [applyViewport]);

  const toCanvasCoords = useCallback((clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return { x: 0, y: 0 };
    const rect = vp.getBoundingClientRect();
    const { panX, panY, zoom } = view.current;
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }, []);

  const getItemCenter = useCallback((item: Item) => {
    const el = itemEls.current.get(item.id);
    if (!el) return { x: item.x + ITEM_DEFAULT_W / 2, y: item.y + ITEM_DEFAULT_H / 2 };
    return { x: item.x + el.offsetWidth / 2, y: item.y + el.offsetHeight / 2 };
  }, []);

  const applyItemTransform = useCallback(
    (id: string, x: number, y: number, rotation: number, scale: number) => {
      const el = itemEls.current.get(id);
      if (!el) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.transform = `rotate(${rotation}deg) scale(${scale})`;
    },
    []
  );

  // ── 数据加载 ──
  const loadItems = useCallback(async () => {
    try {
      const res = await fetch('/api/photowall', { credentials: 'same-origin' });
      const data = (await res.json()) as { code: number; items?: ApiItem[] };
      if (data.code === 200 && data.items) {
        setItems(data.items.map(fromApi));
      }
    } catch {
      toast('加载照片墙失败', 'error');
    }
  }, []);

  // ── 持久化（释放时调用）──
  const patchItem = useCallback(
    async (
      id: string,
      body: { x?: number; y?: number; rotation?: number; scale?: number; z_index?: number }
    ): Promise<Item | null> => {
      try {
        const res = await fetch(`/api/photowall/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { code: number; message?: string; item?: ApiItem };
        if (data.code === 200 && data.item) return fromApi(data.item);
        toast(data.message || '保存失败', 'error');
      } catch {
        toast('保存失败', 'error');
      }
      return null;
    },
    []
  );

  // ── 选中 / 取消 ──
  const selectItem = useCallback((id: string) => {
    setSelectedId(id);
    setDetailUpdated(false); // 新选中时“上传时间”回到 created_at
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedId(null);
  }, []);

  // ── 上移/下移一层：与相邻层逐层交换 z_index（对齐 Flask move-layer 语义）──
  //   Flask 按 (z_index ASC, created_at ASC) 排序取相邻邻居并互换两者 z_index，
  //   每次点击只升/降一层。Next 无 move-layer 端点，用两次 PATCH 互换实现。
  const moveLayer = useCallback(
    async (id: string, direction: 'up' | 'down') => {
      if (!canEditRef.current) return;
      const sorted = [...itemsRef.current].sort(
        (a, b) => a.zIndex - b.zIndex || (a.createdAt || '').localeCompare(b.createdAt || '')
      );
      const idx = sorted.findIndex((it) => it.id === id);
      if (idx < 0) return;
      let neighbor: Item | undefined;
      if (direction === 'up' && idx < sorted.length - 1) neighbor = sorted[idx + 1];
      else if (direction === 'down' && idx > 0) neighbor = sorted[idx - 1];
      else return; // 已在顶/底层，Flask 原样返回（无变化）
      const item = sorted[idx];
      const iz = item.zIndex;
      const nz = neighbor.zIndex;
      const nid = neighbor.id;
      // 乐观互换两者 z_index
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, zIndex: nz } : it.id === nid ? { ...it, zIndex: iz } : it
        )
      );
      const [savedItem, savedNeighbor] = await Promise.all([
        patchItem(id, { z_index: nz }),
        patchItem(nid, { z_index: iz }),
      ]);
      if (savedItem) setItems((prev) => prev.map((it) => (it.id === id ? savedItem : it)));
      if (savedNeighbor)
        setItems((prev) => prev.map((it) => (it.id === nid ? savedNeighbor : it)));
    },
    [patchItem]
  );

  // ── 摘除照片（DELETE /api/photowall/:id，忠实移植 Flask actionRemove）──
  const removeItem = useCallback(async (id: string) => {
    if (!canEditRef.current) return;
    if (!window.confirm('确定要摘除这张照片吗？')) return;
    try {
      const res = await fetch(`/api/photowall/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = (await res.json().catch(() => ({ code: res.status }))) as {
        code: number;
        message?: string;
      };
      if (data.code === 200) {
        toast('已摘除', 'success');
        setSelectedId(null);
        setItems((prev) => prev.filter((it) => it.id !== id));
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('操作失败', 'error');
    }
  }, []);

  // ── 条目 pointerdown：选中 + 依据手柄进入 move/rotate/scale ──
  const onItemPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, item: Item) => {
      if (ix.current.mode === 'pan') return;
      const handle = (e.target as HTMLElement).dataset.handle;

      // 始终允许选中以查看详情
      selectItem(item.id);

      if (!canEditRef.current) return; // 未登录只读
      if (handle !== 'rotate' && handle !== 'scale') {
        // 点击照片本体 → 移动
        startItemDrag(item, e, 'move');
        return;
      }
      startItemDrag(item, e, handle === 'rotate' ? 'rotate' : 'scale');
    },
    [selectItem]
  );

  const startItemDrag = (item: Item, e: React.PointerEvent, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    const cur = ix.current;
    cur.mode = mode;
    cur.itemId = item.id;
    cur.startClient = { x: e.clientX, y: e.clientY };
    cur.startOffset = { x: item.x, y: item.y };
    cur.work = { x: item.x, y: item.y, rotation: item.rotation, scale: item.scale };
    if (mode === 'rotate') {
      cur.startValue = item.rotation;
      cur.center = getItemCenter(item);
      cur.startCanvas = toCanvasCoords(e.clientX, e.clientY);
    } else if (mode === 'scale') {
      cur.startValue = item.scale;
      cur.center = getItemCenter(item);
      cur.startCanvas = toCanvasCoords(e.clientX, e.clientY);
    }
    const el = itemEls.current.get(item.id);
    if (el) el.classList.add('photo-wall__item--dragging');
  };

  // ── 全局 pointermove / pointerup（同时处理平移与条目拖拽）──
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = ix.current;
      if (cur.mode === 'pan') {
        const dx = e.clientX - cur.startClient.x;
        const dy = e.clientY - cur.startClient.y;
        if (Math.abs(dx) > PAN_THRESHOLD || Math.abs(dy) > PAN_THRESHOLD) cur.panMoved = true;
        if (!cur.panMoved) return;
        view.current.panX = cur.startOffset.x + dx;
        view.current.panY = cur.startOffset.y + dy;
        applyViewport();
        return;
      }
      if (!cur.mode || !cur.itemId) return;
      const zoom = view.current.zoom;
      const dx = (e.clientX - cur.startClient.x) / zoom;
      const dy = (e.clientY - cur.startClient.y) / zoom;

      if (cur.mode === 'move') {
        cur.work.x = cur.startOffset.x + dx;
        cur.work.y = cur.startOffset.y + dy;
      } else if (cur.mode === 'rotate') {
        const { x: cx, y: cy } = cur.center;
        const p = toCanvasCoords(e.clientX, e.clientY);
        const start = (Math.atan2(cur.startCanvas.y - cy, cur.startCanvas.x - cx) * 180) / Math.PI;
        const now = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
        let rot = (cur.startValue + (now - start)) % 360;
        if (rot < 0) rot += 360;
        cur.work.rotation = rot;
      } else if (cur.mode === 'scale') {
        const { x: cx, y: cy } = cur.center;
        const p = toCanvasCoords(e.clientX, e.clientY);
        const startDist = Math.hypot(cur.startCanvas.x - cx, cur.startCanvas.y - cy);
        const nowDist = Math.hypot(p.x - cx, p.y - cy);
        if (startDist > 1) {
          cur.work.scale = Math.max(0.25, Math.min(5.0, cur.startValue * (nowDist / startDist)));
        }
      }
      applyItemTransform(cur.itemId, cur.work.x, cur.work.y, cur.work.rotation, cur.work.scale);
      // 拖拽中实时刷新详情：把“上传时间”切到 updated_at（对齐 Flask updateDetailFields，移动端不刷）
      if (!isMobileRef.current && cur.itemId === selectedIdRef.current) {
        setDetailUpdated(true);
      }
    };

    const onUp = () => {
      const cur = ix.current;
      if (cur.mode === 'pan') {
        cur.mode = null;
        viewportRef.current?.classList.remove('photo-wall__viewport--grabbing');
        if (!cur.panMoved) deselectAll(); // 空白点按 → 取消选中
        return;
      }
      if (!cur.mode || !cur.itemId) return;
      const id = cur.itemId;
      const work = { ...cur.work };
      const el = itemEls.current.get(id);
      if (el) el.classList.remove('photo-wall__item--dragging');
      cur.mode = null;
      cur.itemId = null;

      // 提交本地 + 释放时持久化（拖拽中不发请求）
      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? { ...it, x: work.x, y: work.y, rotation: work.rotation, scale: work.scale }
            : it
        )
      );
      void patchItem(id, {
        x: work.x,
        y: work.y,
        rotation: work.rotation,
        scale: work.scale,
      }).then((saved) => {
        if (saved) setItems((prev) => prev.map((it) => (it.id === id ? saved : it)));
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [applyViewport, applyItemTransform, toCanvasCoords, deselectAll, patchItem]);

  // ── 视口平移起手（空白区域）──
  const onViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== viewportRef.current && e.target !== canvasRef.current) return;
    const cur = ix.current;
    cur.mode = 'pan';
    cur.panMoved = false;
    cur.startClient = { x: e.clientX, y: e.clientY };
    cur.startOffset = { x: view.current.panX, y: view.current.panY };
    viewportRef.current?.classList.add('photo-wall__viewport--grabbing');
  }, []);

  // ── 滚轮缩放（非 passive，需 preventDefault）──
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const oldZoom = view.current.zoom;
      const factor = e.deltaY > 0 ? 0.97 : 1.03;
      const zoom = Math.max(0.1, Math.min(2.0, oldZoom * factor));
      const ratio = zoom / oldZoom;
      view.current.zoom = zoom;
      view.current.panX = mx - ratio * (mx - view.current.panX);
      view.current.panY = my - ratio * (my - view.current.panY);
      applyViewport();
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [applyViewport]);

  // ── 初始化：认证态、视口、数据 ──
  useEffect(() => {
    setIsMobile(window.matchMedia('(max-width: 768px)').matches);

    (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const data = (await res.json()) as { user: { id: string } | null };
        setCanEdit(!!data.user);
      } catch {
        setCanEdit(false);
      }
    })();

    resetView();
    void loadItems();

    const onResize = () => {
      setIsMobile(window.matchMedia('(max-width: 768px)').matches);
      resetView();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [resetView, loadItems]);

  // ── 键盘：Esc 取消选中 / 关闭选图器；Delete/Backspace 摘除选中（未聚焦输入框时）──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        deselectAll();
        setPickerOpen(false);
      }
      // 对齐 Flask：未聚焦任何输入框（activeElement 为 body）时，Delete/Backspace 摘除选中照片
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdRef.current) {
        if (document.activeElement === document.body) {
          void removeItem(selectedIdRef.current);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [deselectAll, removeItem]);

  // ── 选图器：加载我的图床 ──
  const loadMyImages = useCallback(async () => {
    setPickerLoading(true);
    try {
      const res = await fetch('/api/images', { credentials: 'same-origin' });
      const data = (await res.json()) as {
        code: number;
        images?: Array<{ id: string; filename: string; url: string }>;
      };
      if (data.code === 200 && data.images) {
        setPickerImages(data.images.map((i) => ({ id: i.id, filename: i.filename, url: i.url })));
      } else {
        setPickerImages([]);
      }
    } catch {
      setPickerImages([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const openPicker = useCallback(() => {
    if (!canEditRef.current) {
      toast('请先登录后再贴照片', 'warning');
      return;
    }
    setPickerOpen(true);
    setPickerTab('my-images');
    void loadMyImages();
  }, [loadMyImages]);

  // 计算当前视图中心的画布坐标（贴图落点）
  const viewCenterCanvas = useCallback(() => {
    const vp = viewportRef.current;
    const { panX, panY, zoom } = view.current;
    const w = vp?.clientWidth ?? 0;
    const h = vp?.clientHeight ?? 0;
    return { cx: (w / 2 - panX) / zoom, cy: (h / 2 - panY) / zoom };
  }, []);

  const placeImage = useCallback(
    async (imageId: string) => {
      const { cx, cy } = viewCenterCanvas();
      const x = Math.max(0, Math.min(3800, cx + (Math.random() - 0.5) * 300));
      const y = Math.max(0, Math.min(2800, cy + (Math.random() - 0.5) * 200));
      try {
        const res = await fetch('/api/photowall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ image_id: imageId, x, y }),
        });
        const data = (await res.json()) as { code: number; message?: string; item?: ApiItem };
        if (data.code === 200 && data.item) {
          const it = fromApi(data.item);
          setItems((prev) => [...prev, it]);
          setPickerOpen(false);
          toast('已贴到墙上', 'success');
        } else {
          toast(data.message || '放置失败', 'error');
        }
      } catch {
        toast('放置失败', 'error');
      }
    },
    [viewCenterCanvas]
  );

  // 上传新照片 → 先 POST /api/images 得到 id，再 POST /api/photowall 贴墙
  const uploadAndPlace = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('compress', '1');
      try {
        const up = await fetch('/api/images', {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        });
        const upData = (await up.json()) as {
          code: number;
          message?: string;
          id?: string;
        };
        if (upData.code !== 200 || !upData.id) {
          toast(upData.message || '上传失败', 'error');
          return;
        }
        await placeImage(upData.id);
      } catch {
        toast('上传失败', 'error');
      }
    },
    [placeImage]
  );

  const selected = items.find((it) => it.id === selectedId) ?? null;
  const sortedForList = [...items].sort((a, b) => b.zIndex - a.zIndex);
  // 列表顺序签名：仅在条目集合/顺序变化时触发 FLIP（层级变化时列表条目滑动到新位置）
  const listOrderKey = sortedForList.map((it) => it.id).join(',');

  // ── FLIP：底部列表重排时平滑过渡（对齐 Flask renderList 的 translateY → 0 动画）──
  useLayoutEffect(() => {
    // 先量取重排后各条目的新位置
    const newTops = new Map<string, number>();
    listItemEls.current.forEach((el, id) => {
      if (el) newTops.set(id, el.getBoundingClientRect().top);
    });
    // 与上一次位置对比，做 translateY 反演再归零
    newTops.forEach((newTop, id) => {
      const oldTop = prevListTops.current.get(id);
      if (oldTop === undefined) return;
      const delta = oldTop - newTop;
      if (Math.abs(delta) <= 1) return;
      const el = listItemEls.current.get(id);
      if (!el) return;
      el.style.transform = `translateY(${delta}px)`;
      el.style.transition = 'none';
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.3s ease';
        el.style.transform = '';
      });
    });
    prevListTops.current = newTops;
  }, [listOrderKey]);

  return (
    <>
      {/* 视口 + 画布 */}
      <div
        className="photo-wall__viewport"
        ref={viewportRef}
        onPointerDown={onViewportPointerDown}
      >
        <div className="photo-wall__canvas" ref={canvasRef}>
          {items.map((item) => (
            <div
              key={item.id}
              ref={(el) => {
                itemEls.current.set(item.id, el);
              }}
              className={`photo-wall__item${
                item.id === selectedId ? ' photo-wall__item--selected' : ''
              }`}
              data-item-id={item.id}
              style={{
                left: `${item.x}px`,
                top: `${item.y}px`,
                zIndex: item.zIndex,
                width: `${ITEM_DEFAULT_W}px`,
                transform: `rotate(${item.rotation}deg) scale(${item.scale})`,
              }}
              onPointerDown={(e) => onItemPointerDown(e, item)}
            >
              <div className="photo-wall__item__frame">
                {/* 对齐 Flask：始终渲染 <img>，失效时显示浏览器破图图标（不做占位块） */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="photo-wall__item__img"
                  src={item.url || ''}
                  alt=""
                  draggable={false}
                  style={{
                    width: `${ITEM_DEFAULT_W - 20}px`,
                    height: 'auto',
                    objectFit: 'cover',
                  }}
                />
              </div>
              {canEdit && (
                <>
                  <div
                    className="photo-wall__item__handle photo-wall__item__handle--rotate"
                    data-handle="rotate"
                  />
                  <div
                    className="photo-wall__item__handle photo-wall__item__handle--scale"
                    data-handle="scale"
                  />
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="photo-wall__toolbar">
        <button
          className="photo-wall__toolbar-btn photo-wall__toolbar-btn--primary"
          onClick={openPicker}
          type="button"
        >
          + 贴照片
        </button>
        <button className="photo-wall__toolbar-btn" onClick={resetView} type="button">
          重置视角
        </button>
        <span className="photo-wall__toolbar-hint">拖拽空白平移 · 滚轮缩放</span>
      </div>

      {/* 详情浮层（桌面）*/}
      {!isMobile && (
        <>
          <div
            className={`photo-wall__detail-overlay${
              selected ? ' photo-wall__detail-overlay--open' : ''
            }`}
            onClick={deselectAll}
          />
          <div className={`photo-wall__detail${selected ? ' photo-wall__detail--open' : ''}`}>
            <button
              className="photo-wall__detail__close"
              onClick={deselectAll}
              type="button"
              aria-label="关闭"
            >
              &times;
            </button>
            {selected && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="photo-wall__detail__img" src={selected.url} alt="" />
                <div className="photo-wall__detail__body">
                  <div className="photo-wall__detail__field">
                    <strong>作者：</strong>
                    <span>{selected.authorName || '未知'}</span>
                  </div>
                  <div className="photo-wall__detail__field">
                    <strong>照片ID：</strong>
                    <span>{selected.id}</span>
                  </div>
                  <div className="photo-wall__detail__field">
                    <strong>上传时间：</strong>
                    <span>
                      {(() => {
                        // 对齐 Flask：初次选中显示 created_at，拖拽后切到 updated_at
                        const t = detailUpdated ? selected.updatedAt : selected.createdAt;
                        return t ? new Date(t).toLocaleString('zh-CN') : '—';
                      })()}
                    </span>
                  </div>
                  <div className="photo-wall__detail__field">
                    <strong>层级：</strong>
                    <span>{selected.zIndex}</span>
                  </div>
                </div>
                {canEdit && (
                  <div className="photo-wall__detail__actions">
                    <button
                      className="photo-wall__detail__btn photo-wall__detail__btn--up"
                      onClick={() => moveLayer(selected.id, 'up')}
                      type="button"
                    >
                      上移一层
                    </button>
                    <button
                      className="photo-wall__detail__btn photo-wall__detail__btn--down"
                      onClick={() => moveLayer(selected.id, 'down')}
                      type="button"
                    >
                      下移一层
                    </button>
                    <button
                      className="photo-wall__detail__btn photo-wall__detail__btn--danger"
                      onClick={() => removeItem(selected.id)}
                      type="button"
                    >
                      摘除照片
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* 详情条（移动端）*/}
      {isMobile && selected && (
        <div className="photo-wall__mobile-detail" style={{ display: 'flex' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="photo-wall__mobile-detail__thumb" src={selected.url} alt="" />
          <div className="photo-wall__mobile-detail__info">
            <strong>{selected.authorName || '未知'}</strong> · 层级 #{selected.zIndex}
          </div>
          {canEdit && (
            <>
              <button
                className="photo-wall__mobile-detail__btn photo-wall__mobile-detail__btn--up"
                onClick={() => moveLayer(selected.id, 'up')}
                type="button"
              >
                上移
              </button>
              <button
                className="photo-wall__mobile-detail__btn photo-wall__mobile-detail__btn--down"
                onClick={() => moveLayer(selected.id, 'down')}
                type="button"
              >
                下移
              </button>
              <button
                className="photo-wall__mobile-detail__btn photo-wall__mobile-detail__btn--danger"
                onClick={() => removeItem(selected.id)}
                type="button"
              >
                摘除
              </button>
            </>
          )}
        </div>
      )}

      {/* 选图器 */}
      <div
        className={`photo-wall__picker-overlay${
          pickerOpen ? ' photo-wall__picker-overlay--open' : ''
        }`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setPickerOpen(false);
        }}
      >
        <div className="photo-wall__picker" style={{ position: 'relative' }}>
          <button
            className="photo-wall__picker__close"
            onClick={() => setPickerOpen(false)}
            type="button"
            aria-label="关闭"
          >
            &times;
          </button>
          <h3 className="photo-wall__picker__title">选择照片贴到墙上</h3>
          <div className="photo-wall__picker__tabs">
            <button
              className={`photo-wall__picker__tab${
                pickerTab === 'my-images' ? ' photo-wall__picker__tab--active' : ''
              }`}
              onClick={() => {
                setPickerTab('my-images');
                void loadMyImages();
              }}
              type="button"
            >
              我的图床
            </button>
            <button
              className={`photo-wall__picker__tab${
                pickerTab === 'upload-new' ? ' photo-wall__picker__tab--active' : ''
              }`}
              onClick={() => setPickerTab('upload-new')}
              type="button"
            >
              上传新照片
            </button>
          </div>

          {pickerTab === 'my-images' ? (
            <div className="photo-wall__picker__grid">
              {pickerLoading ? (
                <div style={{ color: 'var(--color-text-secondary)', padding: 20 }}>加载中...</div>
              ) : pickerImages.length === 0 ? (
                <div style={{ color: 'var(--color-text-secondary)', padding: 20 }}>
                  暂无可用图片，请先在图床上传或使用“上传新照片”标签。
                </div>
              ) : (
                pickerImages.map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={img.id}
                    className="photo-wall__picker__thumb"
                    src={img.url}
                    title={img.filename}
                    alt={img.filename}
                    onClick={() => placeImage(img.id)}
                  />
                ))
              )}
            </div>
          ) : (
            <div
              className="photo-wall__picker__upload-zone"
              onClick={() => uploadInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)';
              }}
              onDragLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = '';
              }}
              onDrop={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).style.borderColor = '';
                const file = e.dataTransfer.files[0];
                if (file) void uploadAndPlace(file);
              }}
            >
              <div style={{ fontSize: '2rem', marginBottom: 8 }}>+</div>
              <div>点击或拖拽上传</div>
              <div style={{ fontSize: '0.75rem', marginTop: 4 }}>支持 PNG、JPEG、GIF、WebP、SVG</div>
              <input
                type="file"
                accept="image/*"
                ref={uploadInputRef}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadAndPlace(file);
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* 底部列表 */}
      <div className="photo-wall__list-panel">
        <div className="photo-wall__list-header">
          墙上照片 · 按遮挡顺序（靠前 → 靠后）· <span>{items.length}</span> 张
        </div>
        <div className="photo-wall__list">
          {sortedForList.map((item) => (
            <div
              key={item.id}
              ref={(el) => {
                listItemEls.current.set(item.id, el);
              }}
              className={`photo-wall__list-item${
                item.id === selectedId ? ' photo-wall__list-item--active' : ''
              }`}
              data-item-id={item.id}
              onClick={() => selectItem(item.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="photo-wall__list-item__thumb" src={item.url || ''} alt="" />
              <div className="photo-wall__list-item__info">
                <div className="photo-wall__list-item__author">{item.authorName || '未知'}</div>
                <div className="photo-wall__list-item__meta">
                  {item.createdAt ? new Date(item.createdAt).toLocaleDateString('zh-CN') : ''}
                </div>
              </div>
              <span className="photo-wall__list-item__z">#{item.zIndex}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
