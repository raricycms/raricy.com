'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CattcaPlayer — 互动小说 Cattca 引擎的 React 宿主（阅读器版）。
//
// 这次重写只换「宿主内部」，不动编辑器：
//   · 引擎仍在 public/static/js/cattca.js；
//   · props / ref 接口保持不变（script / variant / runId / onStatus / toggleFullscreen）；
//   · 段落不再一个个堆在页面上，而是按「引擎段」分页，一页一页翻；
//   · 书页模式在宽屏/全屏时左右对开，单页模式只显示当前页；
//   · 文字按恒定速度打出，Shift 加速，Ctrl 补完本段；
//   · 全屏不再 innerHTML 镜像，而是同一棵 React 树换布局，因此没有第二套事件绑定。
// ─────────────────────────────────────────────────────────────────────────────

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import CattcaReader from './cattca/CattcaReader';
import { clampPage, paginateHtml, spreadStart, visiblePageIndexes, type PageMetrics } from './cattca/paginate';
import { stripFrontmatter } from './cattca/frontmatter';
import type {
  ReaderMode,
  ReaderPage,
  ReaderPending,
  ReaderSegment,
  ReaderStatus,
} from './cattca/types';

// ── 解释器类型（cattca.js 是纯 JS，这里给出最小构造签名） ──────────────────────

interface CattcaInterpreterInstance {
  load(source: string): void;
  run(): Promise<void>;
  running: boolean;
}

type CattcaCtor = new (
  outputCb: (txt: string) => void,
  logCb: (txt: string) => void,
  inputCb: (prompt: string) => Promise<string>,
  choiceCb: (options: string[]) => Promise<string>,
) => CattcaInterpreterInstance;

// ── 解释器加载：注入一次 module script，挂到 window，模块内静态 import 完成后回读 ──

let loaderPromise: Promise<CattcaCtor> | null = null;

function loadCattca(): Promise<CattcaCtor> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('CattcaPlayer 只能在客户端运行'));
  }
  const w = window as unknown as { __CattcaInterpreter?: CattcaCtor };
  if (w.__CattcaInterpreter) return Promise.resolve(w.__CattcaInterpreter);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<CattcaCtor>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    // 模块内的静态 import 由浏览器原生解析 /static/js/cattca.js（public 目录），
    // Next/webpack 不介入；完成后挂 window 并派发事件。
    script.textContent =
      "import { CattcaInterpreter } from '/static/js/cattca.js';" +
      'window.__CattcaInterpreter = CattcaInterpreter;' +
      "window.dispatchEvent(new Event('cattca:loaded'));";

    const onLoaded = () => {
      window.removeEventListener('cattca:loaded', onLoaded);
      if (w.__CattcaInterpreter) resolve(w.__CattcaInterpreter);
      else reject(new Error('cattca.js 未导出 CattcaInterpreter'));
    };
    window.addEventListener('cattca:loaded', onLoaded);
    script.onerror = () => {
      window.removeEventListener('cattca:loaded', onLoaded);
      loaderPromise = null;
      reject(new Error('cattca.js 加载失败'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

// ── Markdown ────────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(buffer: string): string {
  try {
    const raw = marked.parse(buffer, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  } catch (error) {
    console.error('Markdown parsing error:', error);
    return buffer
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

const FALLBACK_METRICS: PageMetrics = { width: 620, height: 620 };
const MODE_STORAGE_KEY = 'cattca_reader_mode';

function totalPagesOf(segments: ReaderSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.pages.length, 0);
}

/** 全局页码 → 页 key；越界返回 null。 */
function pageKeyAt(segments: ReaderSegment[], index: number): string | null {
  let acc = 0;
  for (const segment of segments) {
    if (index < acc + segment.pages.length) {
      return `${segment.id}:${index - acc}`;
    }
    acc += segment.pages.length;
  }
  return null;
}

/**
 * 重排后把「已读」状态迁移到新的分页上。
 *
 * 不能直接清空：改字号 / 切模式 / 全屏 / 窗口缩放都会重排，清空会让眼前这一页
 * 整段重新打字，选项面板也会因为「最后一页还没看过」而消失。按每段已读页数
 * 等比换算，已读完整的段继续保持完整。
 */
function remapRevealed(
  previousSegments: ReaderSegment[],
  nextSegments: ReaderSegment[],
  previous: Set<string>,
): Set<string> {
  const next = new Set<string>();
  nextSegments.forEach((segment, index) => {
    const before = previousSegments[index];
    if (!before || before.pages.length === 0) return;

    let seen = 0;
    for (let i = 0; i < before.pages.length; i += 1) {
      if (previous.has(`${before.id}:${i}`)) seen += 1;
    }
    if (seen === 0) return;

    const count =
      seen >= before.pages.length
        ? segment.pages.length
        : Math.min(segment.pages.length, Math.max(1, Math.round((seen / before.pages.length) * segment.pages.length)));
    for (let i = 0; i < count; i += 1) next.add(`${segment.id}:${i}`);
  });
  return next;
}

// ── 组件 ────────────────────────────────────────────────────────────────────

export type Variant = 'story' | 'tool';

export interface CattcaPlayerHandle {
  toggleFullscreen: () => void;
  enterFullscreen: () => void;
  exitFullscreen: () => void;
}

interface CattcaPlayerProps {
  script: string;
  variant?: Variant;
  // tool 变体：由页面按钮/快捷键递增以触发（重新）运行；0 或缺省表示尚未运行。
  runId?: number;
  // tool 变体：运行结束/出错时向页面回报状态（“运行完成 / 运行出错”）。
  onStatus?: (text: string, type: 'ready' | 'running' | 'error') => void;
}

const CattcaPlayer = forwardRef<CattcaPlayerHandle, CattcaPlayerProps>(function CattcaPlayer(
  { script, variant = 'story', runId, onStatus },
  ref,
) {
  const isTool = variant === 'tool';

  const [mode, setMode] = useState<ReaderMode>('book');
  const [fullscreen, setFullscreen] = useState(false);
  const [segments, setSegments] = useState<ReaderSegment[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pending, setPending] = useState<ReaderPending | null>(null);
  const [status, setStatus] = useState<ReaderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [metrics, setMetrics] = useState<PageMetrics | null>(null);

  const segmentsRef = useRef<ReaderSegment[]>([]);
  const pageIndexRef = useRef(0);
  const pendingRef = useRef<ReaderPending | null>(null);
  const revealedRef = useRef<Set<string>>(new Set());
  const metricsRef = useRef<PageMetrics | null>(null);
  const spreadRef = useRef(false);
  const followLatestRef = useRef(true);
  const bufferRef = useRef('');
  const engineRef = useRef<CattcaInterpreterInstance | null>(null);
  const runTokenRef = useRef(0);
  const segmentIdRef = useRef(0);
  const errorRef = useRef<string | null>(null);
  const modeLoadedRef = useRef(false);

  const pages = useMemo<ReaderPage[]>(() => {
    const out: ReaderPage[] = [];
    let globalIndex = 0;
    segments.forEach((segment, segmentIndex) => {
      segment.pages.forEach((html, pageInSegment) => {
        out.push({
          key: `${segment.id}:${pageInSegment}`,
          html,
          globalIndex: globalIndex++,
          segmentIndex,
          pageIndex: pageInSegment,
          segmentId: segment.id,
        });
      });
    });
    return out;
  }, [segments]);

  const commitPageIndex = useCallback((index: number) => {
    pageIndexRef.current = index;
    setPageIndex(index);
  }, []);

  const setFollowLatest = useCallback((value: boolean) => {
    followLatestRef.current = value;
  }, []);

  // ── 分页 / 段落 ────────────────────────────────────────────────────────────

  const appendSegment = useCallback(
    (html: string) => {
      const pageHtmls = paginateHtml(html, metricsRef.current ?? FALLBACK_METRICS);
      const segment: ReaderSegment = {
        id: ++segmentIdRef.current,
        html,
        pages: pageHtmls.length > 0 ? pageHtmls : [''],
      };
      const next = [...segmentsRef.current, segment];
      segmentsRef.current = next;
      setSegments(next);

      if (followLatestRef.current) {
        const start = totalPagesOf(next) - segment.pages.length;
        const current = pageIndexRef.current;
        // 书页模式下，如果新段的第一页正好是当前对开页的右页，就让它填在右页上，
        // 不要跳到「新段 + 空白右页」——否则读者明明已经看到右页是空的，选完之后
        // 却又被翻成新的一组对开页。
        const fillsFacingPage = spreadRef.current && start === current + 1;
        if (!fillsFacingPage) {
          commitPageIndex(start);
        }
      }
    },
    [commitPageIndex],
  );

  const flushSegment = useCallback(() => {
    const buffer = bufferRef.current;
    bufferRef.current = '';
    if (!buffer.trim()) {
      // 空段也要有一页，否则「一进来就是选项」的脚本没有地方显示选项。
      if (segmentsRef.current.length === 0) appendSegment('');
      return;
    }
    appendSegment(renderMarkdown(buffer));
  }, [appendSegment]);

  const repaginateAll = useCallback(
    (nextMetrics: PageMetrics) => {
      const current = segmentsRef.current;
      if (current.length === 0) return;

      // 记住当前位置（段 + 段内页），重排后尽量落回同一处。
      const oldPage = pageIndexRef.current;
      let acc = 0;
      let currentSegment = 0;
      let pageInSegment = 0;
      for (let i = 0; i < current.length; i += 1) {
        const count = current[i].pages.length;
        if (oldPage < acc + count) {
          currentSegment = i;
          pageInSegment = oldPage - acc;
          break;
        }
        acc += count;
        currentSegment = i;
        pageInSegment = Math.max(0, count - 1);
      }

      const next = current.map((segment) => {
        const pageHtmls = paginateHtml(segment.html, nextMetrics);
        return {
          ...segment,
          pages: pageHtmls.length > 0 ? pageHtmls : [''],
        };
      });

      const same = next.every(
        (segment, index) =>
          segment.pages.length === current[index].pages.length &&
          segment.pages.every((page, pageIndex) => page === current[index].pages[pageIndex]),
      );
      if (same) return;

      segmentsRef.current = next;
      setSegments(next);

      let start = 0;
      for (let i = 0; i < currentSegment; i += 1) start += next[i].pages.length;
      const target = start + Math.min(pageInSegment, next[currentSegment].pages.length - 1);
      commitPageIndex(target);

      const nextRevealed = remapRevealed(current, next, revealedRef.current);
      revealedRef.current = nextRevealed;
      setRevealed(nextRevealed);
    },
    [commitPageIndex],
  );

  // 拖动窗口 / 切换布局会连续触发 metrics；等尺寸稳定后再重排，避免每个 RO tick
  // 都把全部段落重新分页一遍（长故事会明显卡顿）。
  useEffect(() => {
    if (!metrics) return;
    const timer = window.setTimeout(() => repaginateAll(metrics), 120);
    return () => window.clearTimeout(timer);
  }, [metrics, repaginateAll]);

  // 图片解码完、字体真正可用之后，之前量到的高度会变；请重新分页一次。
  const requestRelayout = useCallback(() => {
    const current = metricsRef.current;
    if (current) repaginateAll(current);
  }, [repaginateAll]);

  // ── 翻页 / 展开 ────────────────────────────────────────────────────────────

  const handlePageChange = useCallback(
    (index: number) => {
      const total = totalPagesOf(segmentsRef.current);
      const clamped = clampPage(index, total);
      const target = spreadRef.current ? spreadStart(clamped, true) : clamped;
      commitPageIndex(target);
      const last = total - 1;
      const atLatest = spreadRef.current ? target + 1 >= last : target >= last;
      setFollowLatest(atLatest);
    },
    [commitPageIndex, setFollowLatest],
  );

  const handlePageRevealed = useCallback((pageKey: string) => {
    if (revealedRef.current.has(pageKey)) return;
    const next = new Set(revealedRef.current);
    next.add(pageKey);
    revealedRef.current = next;
    setRevealed(next);
  }, []);

  const handleCompleteSegment = useCallback(() => {
    const current = segmentsRef.current;
    if (current.length === 0) return;

    let targetSegment = current.length - 1;
    if (!pendingRef.current) {
      const page = pageIndexRef.current;
      let acc = 0;
      for (let i = 0; i < current.length; i += 1) {
        if (page < acc + current[i].pages.length) {
          targetSegment = i;
          break;
        }
        acc += current[i].pages.length;
      }
    }

    // Ctrl 只把本段「补完」，不改变当前页码：否则读到第 2 段第 1 页按一下 Ctrl
    // 会被弹到段尾，等于跳过了没读的文字。
    const segment = current[targetSegment];
    const nextRevealed = new Set(revealedRef.current);
    for (let i = 0; i < segment.pages.length; i += 1) {
      nextRevealed.add(`${segment.id}:${i}`);
    }
    // 同时补完当前可见页：Ctrl 的目标是「本段」，但读者眼前可能是历史页。
    for (const index of visiblePageIndexes(pageIndexRef.current, totalPagesOf(current), spreadRef.current)) {
      const key = pageKeyAt(current, index);
      if (key) nextRevealed.add(key);
    }
    revealedRef.current = nextRevealed;
    setRevealed(nextRevealed);
  }, []);

  const handleJumpToPending = useCallback(() => {
    const current = segmentsRef.current;
    if (current.length === 0) return;
    if (!pendingRef.current) {
      handleCompleteSegment();
      return;
    }

    const targetSegment = current.length - 1;
    const segment = current[targetSegment];
    const nextRevealed = new Set(revealedRef.current);
    for (let i = 0; i < segment.pages.length; i += 1) {
      nextRevealed.add(`${segment.id}:${i}`);
    }

    let start = 0;
    for (let i = 0; i < targetSegment; i += 1) start += current[i].pages.length;
    const targetPage = start + segment.pages.length - 1;
    for (const index of visiblePageIndexes(targetPage, totalPagesOf(current), spreadRef.current)) {
      const key = pageKeyAt(current, index);
      if (key) nextRevealed.add(key);
    }
    revealedRef.current = nextRevealed;
    setRevealed(nextRevealed);

    commitPageIndex(spreadRef.current ? spreadStart(targetPage, true) : targetPage);
    setFollowLatest(true);
  }, [commitPageIndex, handleCompleteSegment, setFollowLatest]);

  const handleModeChange = useCallback((next: ReaderMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // localStorage 被禁用时不值得打断阅读。
    }
  }, []);

  const handleSpreadChange = useCallback((next: boolean) => {
    if (spreadRef.current === next) return;
    spreadRef.current = next;
  }, []);

  const handleMetricsChange = useCallback((next: PageMetrics) => {
    const previous = metricsRef.current;
    if (
      previous &&
      Math.abs(previous.width - next.width) < 1 &&
      Math.abs(previous.height - next.height) < 1 &&
      previous.fontSize === next.fontSize &&
      previous.lineHeight === next.lineHeight &&
      previous.fontFamily === next.fontFamily &&
      previous.gap === next.gap &&
      previous.textAlign === next.textAlign
    ) {
      return;
    }
    metricsRef.current = next;
    setMetrics(next);
  }, []);

  // ── 选择 / 输入 ────────────────────────────────────────────────────────────

  const resolvePending = useCallback(
    (value: string) => {
      const current = pendingRef.current;
      if (!current) return;
      pendingRef.current = null;
      setPending(null);
      setFollowLatest(true);
      setStatus('running');
      current.resolve(value);
    },
    [setFollowLatest],
  );

  const handleChoose = useCallback(
    (value: string) => {
      if (pendingRef.current?.kind === 'choice') resolvePending(value);
    },
    [resolvePending],
  );

  const handleSubmitInput = useCallback(
    (value: string) => {
      if (pendingRef.current?.kind === 'input') resolvePending(value);
    },
    [resolvePending],
  );

  // ── 引擎生命周期 ──────────────────────────────────────────────────────────

  const cancelRun = useCallback(() => {
    runTokenRef.current += 1;
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) engine.running = false;

    const currentPending = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (currentPending) {
      currentPending.resolve(
        currentPending.kind === 'choice' ? currentPending.options[0] ?? '' : '',
      );
    }
  }, []);

  const startRun = useCallback(() => {
    cancelRun();
    const token = runTokenRef.current;

    bufferRef.current = '';
    segmentsRef.current = [];
    setSegments([]);
    commitPageIndex(0);
    const empty = new Set<string>();
    revealedRef.current = empty;
    setRevealed(empty);
    errorRef.current = null;
    setError(null);
    setLogs([]);
    setStatus('running');
    setFollowLatest(true);
    onStatus?.('运行中...', 'running');

    loadCattca()
      .then((Ctor) => {
        if (token !== runTokenRef.current) return;

        const interpreter = new Ctor(
          (text) => {
            if (token !== runTokenRef.current) return;
            bufferRef.current += text;
          },
          (text) => {
            if (token !== runTokenRef.current) return;
            setLogs((previous) => [...previous.slice(-199), text]);
            if (text.startsWith('执行错误')) {
              errorRef.current = text;
              setError(text);
              setStatus('error');
            }
          },
          () =>
            new Promise<string>((resolve) => {
              if (token !== runTokenRef.current) {
                resolve('');
                return;
              }
              flushSegment();
              const next: ReaderPending = { kind: 'input', resolve };
              pendingRef.current = next;
              setPending(next);
              setStatus('running');
            }),
          (options) =>
            new Promise<string>((resolve) => {
              if (token !== runTokenRef.current) {
                resolve(options[0] ?? '');
                return;
              }
              flushSegment();
              const next: ReaderPending = { kind: 'choice', options, resolve };
              pendingRef.current = next;
              setPending(next);
              setStatus('running');
            }),
        );

        engineRef.current = interpreter;
        // 故事内容在 story-service 里已经剥过 frontmatter（contentRaw），这里再剥一次
        // 会把正文里以 `---` 开头的段落误删；只有工具页直接加载 .cattca 文件时才需要剥。
        interpreter.load(isTool ? stripFrontmatter(script ?? '') : (script ?? ''));
        interpreter
          .run()
          .then(() => {
            if (token !== runTokenRef.current) return;
            flushSegment();
            if (errorRef.current) {
              setStatus('error');
              onStatus?.('运行出错', 'error');
            } else {
              setStatus('ended');
              onStatus?.('运行完成', 'ready');
            }
          })
          .catch((reason: unknown) => {
            if (token !== runTokenRef.current) return;
            const message = reason instanceof Error ? reason.message : String(reason);
            errorRef.current = message;
            setError(message);
            setLogs((previous) => [...previous, '错误: ' + message]);
            setStatus('error');
            onStatus?.('运行出错', 'error');
          });
      })
      .catch((reason: unknown) => {
        if (token !== runTokenRef.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        errorRef.current = message;
        setError(message);
        setLogs((previous) => [...previous, '错误: ' + message]);
        setStatus('error');
        onStatus?.('运行出错', 'error');
      });
  }, [cancelRun, commitPageIndex, flushSegment, onStatus, script, setFollowLatest]);

  // 运行触发：story 一挂载就跑；tool 等 runId > 0（点「运行脚本」）。
  useEffect(() => {
    if (isTool && (runId ?? 0) <= 0) {
      setStatus('idle');
      return;
    }
    startRun();
    return () => {
      cancelRun();
    };
  }, [cancelRun, isTool, runId, startRun]);

  // 恢复阅读样式偏好；服务端渲染默认书页，客户端恢复后不产生 hydration 差异。
  useEffect(() => {
    if (modeLoadedRef.current) return;
    modeLoadedRef.current = true;
    try {
      const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
      if (saved === 'book' || saved === 'single') setMode(saved);
    } catch {
      // ignore
    }
  }, []);

  // 书页模式下不再强制对齐到偶数页：段可能从任意页开始，强制对齐会把读者
  // 从当前页弹回上一页。可见页由 visiblePageIndexes 直接取 [pageIndex, pageIndex+1]。

  // 全屏：锁 body 滚动，Esc 由阅读器处理。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = fullscreen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [fullscreen]);

  useImperativeHandle(
    ref,
    () => ({
      toggleFullscreen: () => setFullscreen((value) => !value),
      enterFullscreen: () => setFullscreen(true),
      exitFullscreen: () => setFullscreen(false),
    }),
    [],
  );

  const handleRestart = useCallback(() => {
    startRun();
  }, [startRun]);

  return (
    <CattcaReader
      variant={variant}
      status={status}
      pages={pages}
      pageIndex={pageIndex}
      mode={mode}
      fullscreen={fullscreen}
      pending={pending}
      error={error}
      logs={logs}
      revealed={revealed}
      onModeChange={handleModeChange}
      onToggleFullscreen={() => setFullscreen((value) => !value)}
      onPageChange={handlePageChange}
      onPageRevealed={handlePageRevealed}
      onCompleteSegment={handleCompleteSegment}
      onJumpToPending={handleJumpToPending}
      onChoose={handleChoose}
      onSubmitInput={handleSubmitInput}
      onRestart={handleRestart}
      onMetricsChange={handleMetricsChange}
      onSpreadChange={handleSpreadChange}
      onRelayout={requestRelayout}
    />
  );
});

export default CattcaPlayer;
