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
import { FORMATS, LIMITS, formatBytes } from '@/lib/file-converter/formats';
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
        <output>{String(value ?? spec.defaultValue)}{spec.unit ?? ''}</output>
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
      const queue = queueRef.current!;
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

  // 目标变化时重置参数为默认
  useEffect(() => {
    if (!edge) return;
    const defaults: Record<string, unknown> = {};
    for (const p of edge.params) defaults[p.key] = p.defaultValue;
    setParams(defaults);
    setShowAdvanced(false);
  }, [edgeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = useCallback(
    (preset: { category: CategoryKey; edgeId: string; params: Record<string, unknown> }, packagingMode: 'none' | 'zip' | 'gzip') => {
      setCategoryKey(preset.category);
      setEdgeId(preset.edgeId);
      setParams({ ...preset.params });
      setPackaging(packagingMode);
      setPending([]);
    },
    []
  );

  const startConversion = useCallback(() => {
    if (!edge || okPending.length === 0) return;
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
  }, [edge, okPending, params, category]);

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
  const anyAdvanced = (edge?.params ?? []).some((p) => p.advanced);

  return (
    <section className="py-4 base-tool-page fc-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3" style={{ gap: '.5rem' }}>
          <Link
            href="/tool"
            className="text-decoration-none"
            style={{ color: 'var(--color-text-secondary)', display: 'inline-flex' }}
          >
            <span className="icon icon-arrow-left" style={{ width: '1.25rem', height: '1.25rem' }}></span>
          </Link>
          <h1 className="mb-0 tool-new-hero__title">格式转换器</h1>
        </div>
        <p className="tool-new-hero__description">
          文件只在你的浏览器中处理，不会上传。首次转换音频 / 视频需要下载转换组件，之后通常可复用浏览器缓存。
          页面关闭后，尚未保存的结果会丢失。
          <Link href={docHref('guide/格式转换器使用指南')} style={{ marginLeft: '.5rem' }}>
            使用指南
          </Link>
        </p>

        {/* 用途预设（roadmap §14）与固定配方（§12.4） */}
        <div className="fc-presets" role="group" aria-label="用途预设">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="filter-pill"
              title={p.desc}
              onClick={() => applyPreset(p, 'none')}
            >
              {p.label}
            </button>
          ))}
        </div>
        <details className="fc-recipes">
          <summary>固定配方（多步流程，打包下载）</summary>
          <div className="fc-presets">
            {RECIPES.map((p) => (
              <button
                key={p.id}
                type="button"
                className="filter-pill"
                title={p.desc}
                onClick={() => applyPreset(p, p.packaging)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </details>

        {/* 能力区标签 */}
        <div className="fc-tabs" role="tablist" aria-label="能力区">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={categoryKey === c.key}
              className={`filter-pill${categoryKey === c.key ? ' active' : ''}`}
              onClick={() => {
                setCategoryKey(c.key);
                setPending([]);
                setEdgeId(null);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="fc-hint text-muted">{category.hint}</p>

        {/* 文件选择 */}
        <div
          className={`fc-dropzone${dragOver ? ' fc-dropzone--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          <p>把文件拖到这里，或者</p>
          <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            选择文件
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple={category.maxFilesPerTask !== 1}
            accept={category.accept}
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {/* 待转换清单 */}
        {displayPending.length > 0 && (
          <div className="tool-panel fc-panel">
            <h2 className="fc-panel__title">待转换（{displayPending.length}）</h2>
            <ul className="fc-files">
              {displayPending.map((p, i) => (
                <li key={`${p.file.name}-${i}`} className={p.problem ? 'fc-file fc-file--bad' : 'fc-file'}>
                  <span className="fc-file__name">{p.file.name}</span>
                  <span className="fc-file__meta">
                    {p.inspect.sniff.kind} · {formatBytes(p.file.size)}
                    {p.inspect.width ? ` · ${p.inspect.width}×${p.inspect.height}` : ''}
                    {p.inspect.animated ? ' · 动画' : ''}
                  </span>
                  {p.problem ? <span className="fc-file__problem">{p.problem}</span> : null}
                  <button
                    type="button"
                    className="btn btn-secondary fc-file__remove"
                    onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>

            {okPending.length > 0 && (
              <>
                <div className="fc-field">
                  <label htmlFor="fc-target">转换为</label>
                  {candidateEdges.length === 0 ? (
                    <p className="fc-file__problem">这些文件没有共同的可用目标格式</p>
                  ) : (
                    <select
                      id="fc-target"
                      className="form-select"
                      value={edgeId ?? ''}
                      onChange={(e) => setEdgeId(e.target.value)}
                    >
                      <option value="" disabled>
                        选择目标格式
                      </option>
                      {candidateEdges.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.group ? `${e.group} · ` : ''}{e.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {edge && (
                  <div className="fc-params">
                    {edge.params.filter((p) => !p.advanced).map((spec) => (
                      <ParamField
                        key={spec.key}
                        spec={spec}
                        value={params[spec.key]}
                        info={okPending[0]?.inspect ?? null}
                        allParams={params}
                        onChange={(v) => setParams((prev) => ({ ...prev, [spec.key]: v }))}
                      />
                    ))}
                    {anyAdvanced && (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-expanded={showAdvanced}
                          onClick={() => setShowAdvanced((v) => !v)}
                        >
                          {showAdvanced ? '收起高级选项' : '高级选项'}
                        </button>
                        {showAdvanced &&
                          edge.params.filter((p) => p.advanced).map((spec) => (
                            <ParamField
                              key={spec.key}
                              spec={spec}
                              value={params[spec.key]}
                              info={okPending[0]?.inspect ?? null}
                              allParams={params}
                              onChange={(v) => setParams((prev) => ({ ...prev, [spec.key]: v }))}
                            />
                          ))}
                      </>
                    )}
                    {edge.notices.length > 0 && (
                      <ul className="fc-notices">
                        {edge.notices.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                    <div className="fc-actions">
                      <button type="button" className="btn btn-primary" onClick={startConversion}>
                        开始转换（{okPending.length} 个文件）
                      </button>
                      {okPending.length > 1 && (
                        <label className="fc-pack">
                          <input
                            type="checkbox"
                            checked={packaging !== 'none'}
                            onChange={(e) => setPackaging(e.target.checked ? 'zip' : 'none')}
                          />
                          完成后提供打包下载（ZIP）
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 预算暂停横幅 */}
        {snap.budgetPaused && (
          <div className="alert alert-warning" role="alert">
            输出暂存已达上限，队列已暂停。请先下载并移除一些结果，转换会继续。
          </div>
        )}

        {/* 任务列表 */}
        {snap.tasks.length > 0 && (
          <div className="tool-panel fc-panel">
            <div className="fc-panel__head">
              <h2 className="fc-panel__title">任务（{snap.tasks.length}）</h2>
              <div>
                {succeededCount > 0 && (
                  <button type="button" className="btn btn-secondary" onClick={() => void packOutputs()}>
                    打包下载全部成功结果（{succeededCount}）
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => queueRef.current!.cancelAll()}>
                  取消全部
                </button>
              </div>
            </div>
            <ul className="fc-tasks">
              {snap.tasks.map((t) => (
                <li key={t.id} className={`fc-task fc-task--${t.status}`} data-edge={t.edgeId}>
                  <div className="fc-task__row">
                    <span className="fc-task__name">{t.fileName}</span>
                    <span className="fc-task__status">{statusText(t)}{t.message ? ` · ${t.message}` : ''}</span>
                  </div>
                  {(t.status === 'converting' || t.status === 'loading-engine' || t.status === 'probing') && (
                    <progress
                      className="fc-progress"
                      max={1}
                      value={t.progress ?? undefined}
                      aria-label={`${t.fileName} 进度`}
                    />
                  )}
                  {t.status === 'failed' && t.error && (
                    <div className="fc-task__error" role="alert">
                      {t.error.message}
                      {t.error.detail ? <details><summary>诊断信息</summary><pre>{t.error.detail}</pre></details> : null}
                    </div>
                  )}
                  {t.status === 'succeeded' && t.result && (
                    <div className="fc-result">
                      <div className="fc-result__meta">
                        {formatBytes(t.result.inputSize)} → {formatBytes(t.result.outputSize)}
                        {t.result.outputSize > t.result.inputSize ? '（输出更大）' : ''}
                      </div>
                      {t.result.notices.length > 0 && (
                        <ul className="fc-notices">
                          {t.result.notices.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                      <TaskPreview task={t} registerUrl={registerUrl} />
                      <div className="fc-result__actions">
                        {t.result.outputs.map((o, i) => (
                          <button
                            key={o.name}
                            type="button"
                            className="btn btn-primary"
                            onClick={() => downloadOutput(t, i)}
                          >
                            下载 {o.name}（{formatBytes(o.blob.size)}）
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="fc-task__ops">
                    {(t.status === 'queued' || t.status === 'converting' || t.status === 'loading-engine' || t.status === 'probing') && (
                      <button type="button" className="btn btn-secondary" onClick={() => queueRef.current!.cancel(t.id)}>
                        取消
                      </button>
                    )}
                    {(t.status === 'failed' || t.status === 'cancelled') && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        title="沿用开始时的参数快照重试"
                        onClick={() => queueRef.current!.retry(t.id)}
                      >
                        重试
                      </button>
                    )}
                    <button type="button" className="btn btn-secondary" onClick={() => removeTask(t.id)}>
                      移除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div aria-live="polite" className="fc-sr-status">{announce}</div>
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
