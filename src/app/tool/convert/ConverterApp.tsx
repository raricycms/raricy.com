'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ConverterApp —— 格式转换器主界面。
//
// 八个能力区共用一个文件选择、任务队列、参数预设、错误反馈与下载（roadmap §1）。
// 本组件不认识任何具体格式 —— 目标列表来自能力登记表（registry.ts）按
// 「识别结果 × 运行时能力」过滤后的边，转换本身由各类别模块的 runner 执行。
//
// 纪律（plan §5 / §9）：
//   · 文件名一律纯文本渲染（React 默认转义，不碰 dangerouslySetInnerHTML）；
//   · 参数在「开始转换」那一刻冻结进任务快照；
//   · 每个结果独立下载按钮，批量不触发连续自动下载；
//   · 状态经一个 aria-live=polite 区域播报，不在每次进度事件上打断。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docHref } from '@/lib/docs-catalog';
import { CATEGORIES } from '@/lib/file-converter/categories';
import { makeExecutor, tasksForBatch } from '@/lib/file-converter/execute';
import { LIMITS, METHOD_LABELS, formatBytes } from '@/lib/file-converter/formats';
import { inspectFileClient } from '@/lib/file-converter/inspect-client';
import { PRESETS, RECIPES } from '@/lib/file-converter/presets';
import { ConvertQueue } from '@/lib/file-converter/queue';
import { availableEdges, edgeById } from '@/lib/file-converter/registry';
import type {
  CapabilityReport,
  CategoryKey,
  ConvertTask,
  EdgeDef,
  InspectInfo,
  ParamSpec,
  QueueSnapshot,
} from '@/lib/file-converter/types';
import { downloadBlob } from '@/lib/file-converter/utils';

// ─── 能力探测 ────────────────────────────────────────────────────────────────

async function probeCanvasEncode(mime: string): Promise<boolean> {
  try {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, 0.9));
    if (!blob || blob.type !== mime) return false;
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (mime === 'image/webp') {
      return (
        String.fromCharCode(...head.slice(0, 4)) === 'RIFF' &&
        String.fromCharCode(...head.slice(8, 12)) === 'WEBP'
      );
    }
    if (mime === 'image/avif') {
      return String.fromCharCode(...head.slice(4, 8)) === 'ftyp';
    }
    return true;
  } catch {
    return false;
  }
}

async function probeAvifDecode(): Promise<boolean> {
  try {
    if (typeof createImageBitmap !== 'function') return false;
    // 1x1 AVIF（最小合法文件）
    const b64 =
      'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAACMAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLMXBjb3AAAAABY29scgAAAA==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/avif' }));
    bmp.close();
    return true;
  } catch {
    return false;
  }
}

async function probeCapabilities(): Promise<CapabilityReport> {
  const [webpEncode, avifEncode, avifDecode] = await Promise.all([
    probeCanvasEncode('image/webp'),
    probeCanvasEncode('image/avif'),
    probeAvifDecode(),
  ]);
  return {
    webpEncode,
    avifEncode,
    avifDecode,
    workerOk: typeof Worker !== 'undefined',
    ffmpeg: null, // 核心未加载；首次音频 / 视频任务触发加载
  };
}

// ─── 小组件 ──────────────────────────────────────────────────────────────────

interface PendingFile {
  file: File;
  inspect: InspectInfo;
  problem: string | null;
}

const TAB_LABELS: Record<CategoryKey, string> = {
  image: '图片', audio: '音频', video: '视频', document: '文档',
  table: '表格', text: '文本 / 字幕', ebook: '电子书', archive: '压缩包',
};

function defaultParams(edge: EdgeDef): Record<string, unknown> {
  return Object.fromEntries(edge.params.map((p) => [p.key, p.defaultValue]));
}

function statusText(t: ConvertTask): string {
  switch (t.status) {
    case 'validating': return '校验中';
    case 'queued': return '排队中';
    case 'loading-engine': return '加载转换组件';
    case 'probing': return '探测媒体信息';
    case 'converting': return '转换中';
    case 'succeeded': return '完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
  }
}

function ParamField({
  spec,
  value,
  info,
  allParams,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  info: InspectInfo | null;
  allParams: Record<string, unknown>;
  onChange: (v: string | number | boolean) => void;
}) {
  if (spec.visibleIf && !spec.visibleIf(allParams)) return null;
  const id = `fc-param-${spec.key}`;
  let control: React.ReactNode = null;
  if (spec.type === 'select') {
    const opts = typeof spec.options === 'function' ? spec.options(info) : (spec.options ?? []);
    control = (
      <select
        id={id}
        className="form-select"
        value={String(value ?? spec.defaultValue)}
        onChange={(e) => onChange(e.target.value)}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (spec.type === 'range') {
    control = (
      <span className="fc-range">
        <input
          id={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={Number(value ?? spec.defaultValue)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id}>{String(value ?? spec.defaultValue)}{spec.unit ?? ''}</output>
      </span>
    );
  } else if (spec.type === 'number') {
    control = (
      <input
        id={id}
        type="number"
        className="form-control"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        value={Number(value ?? spec.defaultValue)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  } else if (spec.type === 'color') {
    control = (
      <input
        id={id}
        type="color"
        value={String(value ?? spec.defaultValue)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (spec.type === 'checkbox') {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={Boolean(value ?? spec.defaultValue)}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        className="form-control"
        value={String(value ?? spec.defaultValue)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className={`fc-param${spec.advanced ? ' fc-param--advanced' : ''}`}>
      <label htmlFor={id}>{spec.label}</label>
      {control}
      {spec.help ? <small className="text-muted">{spec.help}</small> : null}
    </div>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export default function ConverterApp() {
  const [categoryKey, setCategoryKey] = useState<CategoryKey>('image');
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [snap, setSnap] = useState<QueueSnapshot>({ tasks: [], activeId: null, budgetPaused: false, heldOutputTotal: 0 });
  const [announce, setAnnounce] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [packaging, setPackaging] = useState<'none' | 'zip' | 'gzip'>('none');
  const [presetId, setPresetId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const capsRef = useRef<CapabilityReport | null>(null);
  // 预览 / 下载的 Blob URL 登记表（队列不感知 URL，见 queue.ts 的注释）
  const urlRegistry = useRef(new Map<string, string[]>());

  const category = useMemo(() => CATEGORIES.find((c) => c.key === categoryKey)!, [categoryKey]);

  const queueRef = useRef<ConvertQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new ConvertQueue(
      makeExecutor(CATEGORIES, () => capsRef.current ?? {
        webpEncode: false, avifEncode: false, avifDecode: false, workerOk: true, ffmpeg: null,
      }),
      { onChange: setSnap }
    );
  }

  useEffect(() => {
    let cancelled = false;
    void probeCapabilities().then((c) => {
      if (cancelled) return;
      capsRef.current = c;
      setCaps(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时回收所有 Blob URL（plan §7.2）
  useEffect(() => {
    const registry = urlRegistry.current;
    return () => {
      for (const urls of registry.values()) urls.forEach((u) => URL.revokeObjectURL(u));
      registry.clear();
    };
  }, []);

  const registerUrl = useCallback((taskId: string, url: string) => {
    const list = urlRegistry.current.get(taskId) ?? [];
    list.push(url);
    urlRegistry.current.set(taskId, list);
  }, []);

  const releaseTaskUrls = useCallback((taskId: string) => {
    const urls = urlRegistry.current.get(taskId);
    if (urls) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urlRegistry.current.delete(taskId);
    }
  }, []);

  // ── 文件进入 ──────────────────────────────────────────────────────────────

  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (!files.length) return;
      setAnnounce(`正在识别 ${files.length} 个文件`);
      const newPending: PendingFile[] = [];
      for (const file of files) {
        if (file.size === 0) {
          newPending.push({
            file,
            inspect: { sniff: { kind: 'unknown', mime: '', ext: '' }, name: file.name, size: 0 },
            problem: '空文件，无法转换',
          });
          continue;
        }
        try {
          const inspect = await inspectFileClient(file);
          // ⚠️ 这里**只记内在问题**（空文件 / 识别失败），不记「没有可用目标」。
          // 那一判是**能力相关**的（caps 未就绪时 availableEdges 恒为空），
          // 存下来就再也得不到重算 —— 症状是「能力探测完成前拖进来的文件被永久
          // 打上『当前类别不支持该文件』」，而重试用例里同样的文件却能转。
          // 现在的口径：显示层每次按当前 caps 重算（见 displayPending）。
          newPending.push({ file, inspect, problem: null });
          // 深度探测的门槛在 caps 未就绪时退回**与能力无关**的「这个类别有没有
          // 接这种内容的边」——否则 caps 为 null 时永不探测，动态选项（选音轨 /
          // 选工作表）永远只有兜底项。
          const plausible =
            caps !== null
              ? availableEdges(category, inspect, caps).length > 0
              : category.edges.some(
                  (e) => e.from.includes(inspect.sniff.kind) && (e.match ? e.match(inspect) : true)
                );
          // 深度探测（类别声明了 probe 才跑）：补 sheets / streams / pageCount。
          // 非阻塞 —— 参数选择器在探测回来前先显示静态选项；probe 契约要求自行
          // 降级不抛，这里再兜一层防意外。
          if (category.probe && plausible) {
            const target = file;
            void category
              .probe(file, inspect)
              .then((patch) => {
                if (!patch || Object.keys(patch).length === 0) return;
                setPending((prev) =>
                  prev.map((p) => (p.file === target ? { ...p, inspect: { ...p.inspect, ...patch } } : p))
                );
              })
              .catch(() => {});
          }
        } catch {
          newPending.push({
            file,
            inspect: { sniff: { kind: 'unknown', mime: '', ext: '' }, name: file.name, size: file.size },
            problem: '识别失败',
          });
        }
      }
      setPending((prev) => {
        const cap = category.maxFilesPerTask > 1 ? category.maxFilesPerTask : LIMITS.queue.maxTasks;
        const merged = [...prev, ...newPending].slice(0, Math.max(cap, 1) === 1 ? LIMITS.queue.maxTasks : cap);
        return merged;
      });
      setAnnounce('');
    },
    [caps, category]
  );

  // ── 待转换的显示模型 ────────────────────────────────────────────────────────
  //
  // 「这个文件当前没有可用目标」是**能力相关**的判据，必须随 caps 现算：
  // 存在 PendingFile.problem 里的话，能力探测完成前拖进来的文件就永远停在
  // 「不支持」上（它只在 addFiles 那一刻算过一次）。所以分两层 ——
  //   · 存的 problem：内在的（空文件 / 识别失败），与 caps 无关；
  //   · 显示的 problem：内在的，或「caps 已就绪但没有可用边」。
  // 列表与目标选择器读的都是 displayPending。
  const displayPending = useMemo(
    () =>
      pending.map((p) => ({
        ...p,
        problem:
          p.problem ??
          (caps && availableEdges(category, p.inspect, caps).length === 0
            ? '当前类别不支持该文件，或所需能力不可用'
            : null),
      })),
    [pending, caps, category]
  );

  // 可选目标 = 所有「无问题」待转换文件的可执行边的交集
  const okPending = displayPending.filter((p) => !p.problem);
  const candidateEdges = useMemo(() => {
    if (!caps || okPending.length === 0) return [];
    let edges = availableEdges(category, okPending[0].inspect, caps);
    for (const p of okPending.slice(1)) {
      const ids = new Set(availableEdges(category, p.inspect, caps).map((e) => e.id));
      edges = edges.filter((e) => ids.has(e.id));
    }
    return edges;
  }, [caps, okPending, category]);

  const edge: EdgeDef | null = edgeId ? edgeById([category], edgeId) : null;

  const selectEdge = (id: string) => {
    const selected = edgeById([category], id);
    setEdgeId(id);
    setParams(selected ? defaultParams(selected) : {});
    setShowAdvanced(false);
    setPresetId(null);
  };

  const selectCategory = (key: CategoryKey) => {
    if (key === categoryKey) return;
    setCategoryKey(key);
    setPending([]);
    setEdgeId(null);
    setParams({});
    setPresetId(null);
    setShowAdvanced(false);
    setPackaging('none');
  };

  const changeParam = (key: string, value: string | number | boolean) => {
    setParams((prev) => ({ ...prev, [key]: value }));
    setPresetId(null);
  };

  const applyPreset = useCallback(
    (preset: { id: string; category: CategoryKey; edgeId: string; params: Record<string, unknown> }, packagingMode: 'none' | 'zip' | 'gzip') => {
      const selected = edgeById(CATEGORIES, preset.edgeId);
      setCategoryKey(preset.category);
      setEdgeId(preset.edgeId);
      // 预设在一次操作里覆盖默认参数，避免目标变化后的 effect 把预设冲掉。
      setParams({ ...(selected ? defaultParams(selected) : {}), ...preset.params });
      setPackaging(packagingMode);
      setPresetId(preset.id);
      setShowAdvanced(false);
      // 同类用途可以在选完文件后切换，不应清空用户刚添加的文件。
      if (preset.category !== categoryKey) setPending([]);
    },
    [categoryKey]
  );

  const startConversion = useCallback(() => {
    if (!edge || okPending.length === 0) return;
    // ⚠️ `edge` 是**按 id 查出来的**（edgeById），不保证它出现在当前候选集里：
    // 预设会把 edgeId 直接写成它自己那条边，而手上的文件可能并不适合它
    // （能力不可用 / 内容不符）—— 不挡的话就拿一条当前不可执行的边去跑，
    // 失败发生在 runner 深处、文案是引擎级的，看不出「这本来就不该点」。
    // 以**候选集**为准：不在其中就是没得转。
    if (!candidateEdges.some((e) => e.id === edge.id)) {
      setAnnounce('当前文件与所选目标不匹配，请重新选择目标格式');
      return;
    }
    const queue = queueRef.current!;
    const admit = queue.admitError(okPending.map((p) => p.file));
    if (admit) {
      setAnnounce(admit);
      return;
    }
    const tasks = tasksForBatch(
      edge,
      category,
      okPending.map((p) => ({ file: p.file, inspect: p.inspect })),
      params
    );
    for (const t of tasks) queue.enqueue(t);
    setAnnounce(`已加入 ${tasks.length} 个任务`);
    setPending([]);
  }, [edge, candidateEdges, okPending, params, category]);

  // ── 结果操作 ──────────────────────────────────────────────────────────────

  const downloadOutput = useCallback(
    (task: ConvertTask, index: number) => {
      const out = task.result?.outputs[index];
      if (!out) return;
      const url = downloadBlob(out.blob, out.name);
      registerUrl(task.id, url);
    },
    [registerUrl]
  );

  const packOutputs = useCallback(async () => {
    const succeeded = snap.tasks.filter((t) => t.status === 'succeeded' && t.result);
    if (succeeded.length === 0) return;
    const { zipSync, gzipSync } = await import('fflate');
    if (packaging === 'gzip' && succeeded.length === 1 && succeeded[0].result!.outputs.length === 1) {
      const out = succeeded[0].result!.outputs[0];
      const data = new Uint8Array(await out.blob.arrayBuffer());
      const gz = gzipSync(data);
      downloadBlob(new Blob([gz.buffer as ArrayBuffer], { type: 'application/gzip' }), `${out.name}.gz`);
      return;
    }
    const entries: Record<string, Uint8Array> = {};
    for (const t of succeeded) {
      for (const out of t.result!.outputs) {
        entries[out.name] = new Uint8Array(await out.blob.arrayBuffer());
      }
    }
    const zipped = zipSync(entries, { level: 0 });
    downloadBlob(new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' }), 'converted.zip');
  }, [snap.tasks, packaging]);

  const removeTask = useCallback(
    (id: string) => {
      releaseTaskUrls(id);
      queueRef.current!.remove(id);
    },
    [releaseTaskUrls]
  );

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const succeededCount = snap.tasks.filter((t) => t.status === 'succeeded').length;
  const activeCount = snap.tasks.filter((t) => !['succeeded', 'failed', 'cancelled'].includes(t.status)).length;
  const anyAdvanced = (edge?.params ?? []).some((p) => p.advanced);
  const edgeAvailable = !!edge && candidateEdges.some((e) => e.id === edge.id);
  const categoryPresets = PRESETS.filter((p) => p.category === categoryKey);
  const categoryRecipes = RECIPES.filter((p) => p.category === categoryKey);
  const selectedPreset = [...PRESETS, ...RECIPES].find((p) => p.id === presetId);
  const startHint = !pending.length
    ? '添加文件后，即可选择适用的输出格式。'
    : !caps
      ? '正在检查浏览器的转换能力…'
      : okPending.length === 0
        ? '请移除有问题的文件，并添加当前分类支持的文件。'
        : !candidateEdges.length
          ? '这些文件没有共同的输出格式，请分批添加。'
          : !edgeAvailable
            ? '请选择适用于当前文件的输出格式。'
            : `已准备好转换 ${okPending.length} 个文件。`;

  return (
    <section className="base-tool-page fc-page">
      <div className="container">
        <nav className="fc-nav" aria-label="工具导航">
          <Link href="/tool" className="fc-nav__back">
            <span className="icon icon-arrow-left" aria-hidden="true" />
            工具箱
          </Link>
          <Link href={docHref('guide/格式转换器使用指南')} className="fc-nav__guide">
            <span className="icon icon-book" aria-hidden="true" />
            使用指南
          </Link>
        </nav>

        <header className="fc-hero">
          <div>
            <h1>格式转换器</h1>
            <p>换个格式，让文件用在你需要的地方。</p>
          </div>
          <span className="fc-local">本地处理 · 文件不会上传</span>
        </header>

        <div className="fc-tabs" role="tablist" aria-label="文件分类">
          {CATEGORIES.map((c, index) => (
            <button
              key={c.key}
              id={`fc-tab-${c.key}`}
              type="button"
              role="tab"
              aria-selected={categoryKey === c.key}
              aria-controls="fc-workspace"
              tabIndex={categoryKey === c.key ? 0 : -1}
              className={`fc-tab${categoryKey === c.key ? ' is-active' : ''}`}
              onClick={() => selectCategory(c.key)}
              onKeyDown={(e) => {
                let next = index;
                if (e.key === 'ArrowRight') next = (index + 1) % CATEGORIES.length;
                else if (e.key === 'ArrowLeft') next = (index + CATEGORIES.length - 1) % CATEGORIES.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = CATEGORIES.length - 1;
                else return;
                e.preventDefault();
                selectCategory(CATEGORIES[next].key);
                document.getElementById(`fc-tab-${CATEGORIES[next].key}`)?.focus();
              }}
            >
              {TAB_LABELS[c.key]}
            </button>
          ))}
        </div>

        <div id="fc-workspace" role="tabpanel" aria-labelledby={`fc-tab-${categoryKey}`}>
          <div className="fc-workspace">
            <section className="fc-panel" aria-labelledby="fc-files-title">
              <div className="fc-panel__head">
                <h2 id="fc-files-title" className="fc-panel__title">
                  <span className="fc-step" aria-hidden="true">01</span>添加文件
                </h2>
                <span className="fc-panel__meta">{pending.length ? `${pending.length} 个文件` : TAB_LABELS[categoryKey]}</span>
              </div>
              <div
                className={`fc-dropzone${dragOver ? ' fc-dropzone--over' : ''}${pending.length ? ' fc-dropzone--compact' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void addFiles(e.dataTransfer.files);
                }}
              >
                <span className="fc-dropzone__icon" aria-hidden="true">
                  <span className="icon icon-add" />
                </span>
                <h3>{pending.length ? '继续添加文件' : '把文件拖到这里'}</h3>
                <p>{category.maxFilesPerTask === 1 ? '选择一个文件，在浏览器里完成转换' : '支持一次选择多个文件，在浏览器里完成转换'}</p>
                <button type="button" className={`btn ${pending.length ? 'btn-secondary' : 'btn-primary'}`} onClick={() => fileInputRef.current?.click()}>
                  选择文件
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  aria-label="选择待转换文件"
                  multiple={category.maxFilesPerTask !== 1}
                  accept={category.accept}
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>

              {displayPending.length > 0 && (
                <div className="fc-selection">
                  <div className="fc-selection__head">
                    <h3>已选文件</h3>
                    <button type="button" className="btn btn-secondary" onClick={() => setPending([])}>清空</button>
                  </div>
                  <ul className="fc-files">
                    {displayPending.map((p, i) => (
                      <li key={`${p.file.name}-${i}`} className={p.problem ? 'fc-file fc-file--bad' : 'fc-file'}>
                        <span className="fc-file__icon" aria-hidden="true"><span className="icon icon-journal-text" /></span>
                        <div className="fc-file__body">
                          <span className="fc-file__name">{p.file.name}</span>
                          <span className="fc-file__meta">
                            {p.inspect.sniff.ext.toUpperCase() || '未知格式'} · {formatBytes(p.file.size)}
                            {p.inspect.width ? ` · ${p.inspect.width}×${p.inspect.height}` : ''}
                            {p.inspect.animated ? ' · 动画' : ''}
                          </span>
                          {p.problem ? <span className="fc-file__problem">{p.problem}</span> : null}
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary fc-file__remove"
                          aria-label={`移除 ${p.file.name}`}
                          onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                        >移除</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <details className="fc-support" key={categoryKey}>
                <summary>支持的格式与使用限制</summary>
                <p className="fc-hint">{category.hint}</p>
                <p className="fc-support__formats">可选择：{category.accept.replaceAll('.', '').replaceAll(',', ' · ')}</p>
              </details>
            </section>

            <section className="fc-panel" aria-labelledby="fc-settings-title">
              <div className="fc-panel__head">
                <h2 id="fc-settings-title" className="fc-panel__title">
                  <span className="fc-step" aria-hidden="true">02</span>设置输出
                </h2>
                <span className="icon icon-gear" aria-hidden="true" />
              </div>

              {categoryPresets.length > 0 && (
                <div className="fc-shortcuts">
                  <p className="fc-shortcuts__label">按用途快速设置</p>
                  <div className="fc-presets" role="group" aria-label="用途预设">
                    {categoryPresets.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`filter-pill${presetId === p.id ? ' is-active' : ''}`}
                        aria-pressed={presetId === p.id}
                        title={p.desc}
                        onClick={() => applyPreset(p, 'none')}
                      >{p.label}</button>
                    ))}
                  </div>
                  {selectedPreset ? <p className="fc-shortcuts__description">{selectedPreset.desc}</p> : null}
                </div>
              )}

              <div className="fc-field">
                <label htmlFor="fc-target">输出格式</label>
                <select
                  id="fc-target"
                  className="form-select"
                  disabled={!caps || candidateEdges.length === 0}
                  value={edgeAvailable ? edgeId! : ''}
                  aria-describedby="fc-start-hint"
                  onChange={(e) => selectEdge(e.target.value)}
                >
                  <option value="" disabled>
                    {!pending.length ? (edge ? `已预设：${edge.label}` : '添加文件后选择格式') : '选择目标格式'}
                  </option>
                  {candidateEdges.map((e) => (
                    <option key={e.id} value={e.id}>{e.group ? `${e.group} · ` : ''}{e.label}</option>
                  ))}
                </select>
              </div>

              {edge && (edgeAvailable || pending.length === 0) && (
                <div className="fc-params">
                  {edge.params.filter((p) => !p.advanced).map((spec) => (
                    <ParamField key={spec.key} spec={spec} value={params[spec.key]} info={okPending[0]?.inspect ?? null} allParams={params} onChange={(v) => changeParam(spec.key, v)} />
                  ))}
                  {anyAdvanced && (
                    <div className="fc-advanced">
                      <button type="button" className="btn btn-secondary" aria-expanded={showAdvanced} aria-controls="fc-advanced-fields" onClick={() => setShowAdvanced((v) => !v)}>
                        {showAdvanced ? '收起高级选项' : '高级选项'} <span aria-hidden="true">{showAdvanced ? '−' : '+'}</span>
                      </button>
                      {showAdvanced && (
                        <div id="fc-advanced-fields" className="fc-params">
                          {edge.params.filter((p) => p.advanced).map((spec) => (
                            <ParamField key={spec.key} spec={spec} value={params[spec.key]} info={okPending[0]?.inspect ?? null} allParams={params} onChange={(v) => changeParam(spec.key, v)} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {edge.notices.length > 0 && (
                    <div className="fc-conversion-note">
                      <p>转换前请留意</p>
                      <ul className="fc-notices">{edge.notices.map((n) => <li key={n}>{n}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}

              {categoryRecipes.length > 0 && (
                <details className="fc-recipes" key={categoryKey}>
                  <summary>批量与打包方案</summary>
                  <div className="fc-presets">
                    {categoryRecipes.map((p) => (
                      <button key={p.id} type="button" className={`filter-pill${presetId === p.id ? ' is-active' : ''}`} aria-pressed={presetId === p.id} title={p.desc} onClick={() => applyPreset(p, p.packaging)}>{p.label}</button>
                    ))}
                  </div>
                </details>
              )}

              <div className="fc-actions">
                {okPending.length > 1 && (
                  <label className="fc-pack">
                    <input type="checkbox" checked={packaging !== 'none'} onChange={(e) => { setPackaging(e.target.checked ? 'zip' : 'none'); setPresetId(null); }} />
                    提供 ZIP 打包下载
                  </label>
                )}
                <button type="button" className="btn btn-primary fc-start" disabled={!edgeAvailable || !okPending.length} onClick={startConversion}>
                  {edgeAvailable && okPending.length ? `开始转换（${okPending.length} 个文件）` : '开始转换'}
                  <span aria-hidden="true">→</span>
                </button>
                <p id="fc-start-hint">{startHint}</p>
              </div>
            </section>
          </div>
        </div>

        {announce && <p className="fc-feedback" role="status">{announce}</p>}
        {snap.budgetPaused && (
          <div className="alert alert-warning" role="alert">输出暂存已达上限，队列已暂停。请先下载并移除一些结果，转换会继续。</div>
        )}

        <section className="fc-panel fc-output" aria-labelledby="fc-output-title">
          <div className="fc-panel__head">
            <h2 id="fc-output-title" className="fc-panel__title"><span className="fc-step" aria-hidden="true">03</span>转换结果</h2>
            <div className="fc-output__ops">
              {succeededCount > 0 && <button type="button" className="btn btn-secondary" onClick={() => void packOutputs()}>打包下载全部成功结果（{succeededCount}）</button>}
              {activeCount > 0 && <button type="button" className="btn btn-secondary" onClick={() => queueRef.current!.cancelAll()}>取消全部</button>}
            </div>
          </div>
          {snap.tasks.length === 0 ? (
            <div className="fc-output__empty">
              <span className="icon icon-box-arrow-right" aria-hidden="true" />
              <p>转换后的文件会出现在这里<span>预览确认后，再保存到你的设备。</span></p>
            </div>
          ) : (
            <>
              <p className="fc-output__summary">{snap.tasks.length} 个任务 · {succeededCount} 个已完成{activeCount ? ` · ${activeCount} 个处理中` : ''}</p>
              <ul className="fc-tasks">
                {snap.tasks.map((t) => (
                  <li key={t.id} className={`fc-task fc-task--${t.status}`} data-edge={t.edgeId}>
                    <div className="fc-task__row">
                      <span className="fc-task__name">{t.fileName}</span>
                      <span className="fc-task__status">{statusText(t)}{t.message ? ` · ${t.message}` : ''}</span>
                    </div>
                    {(t.status === 'converting' || t.status === 'loading-engine' || t.status === 'probing') && <progress className="fc-progress" max={1} value={t.progress ?? undefined} aria-label={`${t.fileName} 进度`} />}
                    {t.status === 'failed' && t.error && (
                      <div className="fc-task__error" role="alert">
                        {t.error.message}
                        {t.error.detail ? <details><summary>诊断信息</summary><pre>{t.error.detail}</pre></details> : null}
                      </div>
                    )}
                    {t.status === 'succeeded' && t.result && (
                      <div className="fc-result">
                        <div className="fc-result__meta">{formatBytes(t.result.inputSize)} → {formatBytes(t.result.outputSize)}{t.result.outputSize > t.result.inputSize ? '（输出更大）' : ''}</div>
                        {(() => {
                          // 队列跨分类保留，转换方式也从完整登记册读取。
                          const completedEdge = edgeById(CATEGORIES, t.edgeId);
                          return completedEdge ? <div className="fc-result__method">转换方式：{METHOD_LABELS[completedEdge.method]}</div> : null;
                        })()}
                        {t.result.notices.length > 0 && <ul className="fc-notices">{t.result.notices.map((n) => <li key={n}>{n}</li>)}</ul>}
                        <TaskPreview task={t} registerUrl={registerUrl} />
                        <div className="fc-result__actions">
                          {t.result.outputs.map((o, i) => <button key={o.name} type="button" className="btn btn-primary" onClick={() => downloadOutput(t, i)}>下载 {o.name}（{formatBytes(o.blob.size)}）</button>)}
                        </div>
                      </div>
                    )}
                    <div className="fc-task__ops">
                      {(t.status === 'queued' || t.status === 'converting' || t.status === 'loading-engine' || t.status === 'probing') && <button type="button" className="btn btn-secondary" onClick={() => queueRef.current!.cancel(t.id)}>取消</button>}
                      {(t.status === 'failed' || t.status === 'cancelled') && <button type="button" className="btn btn-secondary" title="沿用开始时的参数快照重试" onClick={() => queueRef.current!.retry(t.id)}>重试</button>}
                      <button type="button" className="btn btn-secondary" onClick={() => removeTask(t.id)}>移除</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="fc-output__reminder">关闭或刷新页面会清除未保存的结果，请及时下载。</p>
        </section>
        <p className="fc-footnote">音频、视频等转换组件会在需要时加载，首次使用可能稍等片刻。</p>
      </div>
    </section>
  );
}

/** 结果预览：图片直接看、音视频手动播放、文本看头部。透明图用棋盘背景。 */
function TaskPreview({ task, registerUrl }: { task: ConvertTask; registerUrl: (id: string, url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const result = task.result!;

  useEffect(() => {
    if (result.previewKind === 'text') {
      void result.outputs[0].blob.slice(0, 4096).text().then((t) => setText(t));
      return;
    }
    if (result.previewKind === 'none') return;
    const u = URL.createObjectURL(result.outputs[0].blob);
    registerUrl(task.id, u);
    setUrl(u);
  }, [task.id, result, registerUrl]);

  if (result.previewKind === 'text') {
    return text !== null ? <pre className="fc-preview fc-preview--text">{text}{result.outputs[0].blob.size > 4096 ? '\n…' : ''}</pre> : null;
  }
  if (!url) return null;
  if (result.previewKind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="fc-preview fc-preview--image" src={url} alt={`${task.fileName} 的转换结果预览`} />;
  }
  if (result.previewKind === 'audio') {
    return <audio className="fc-preview" controls preload="metadata" src={url} />;
  }
  if (result.previewKind === 'video') {
    return <video className="fc-preview fc-preview--video" controls preload="metadata" src={url} />;
  }
  return null;
}
