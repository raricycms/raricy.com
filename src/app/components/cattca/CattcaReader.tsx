'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CattcaReader —— 纯展示层：分页页面、翻页控件、选择/输入面板、日志。
//
// 引擎、状态与段落分配在 CattcaPlayer 里；这里不碰解释器。
// 两种阅读样式：
//   · book   —— 书本，宽屏/全屏时左右对开
//   · single —— 简洁，保留原阅读区的观感
//
// 翻页规则：
//   · 简洁：←/→ 一页
//   · 书本：←/→ 一组对开页（2 页）
//   · 页码输入可跳到指定页；书本模式落到包含该页的对开页
// ─────────────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Maximize2,
  Minimize2,
  RotateCcw,
  ScrollText,
} from 'lucide-react';
import Typewriter from './Typewriter';
import {
  clampPage,
  movePage,
  spreadStart,
  visiblePageIndexes,
} from './paginate';
import type { ReaderPage, ReaderProps } from './types';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function CattcaReader({
  variant,
  status,
  pages,
  pageIndex,
  mode,
  fullscreen,
  pending,
  error,
  logs,
  revealed,
  onModeChange,
  onToggleFullscreen,
  onPageChange,
  onPageRevealed,
  onCompleteSegment,
  onJumpToPending,
  onChoose,
  onSubmitInput,
  onRestart,
  onMetricsChange,
  onSpreadChange,
}: ReaderProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const choiceListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shiftHeldRef = useRef(false);
  const ctrlComboRef = useRef(false);
  const lastMetricsRef = useRef('');

  const [stageWidth, setStageWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pageText, setPageText] = useState('1');
  const [logsOpen, setLogsOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [choiceCollapsed, setChoiceCollapsed] = useState(false);

  const total = pages.length;
  // 对开必须由**当前实际可用宽度**决定，不能只看 fullscreen：
  // 手机全屏只有 390px，强行双页会把两页压成各 180px，正文根本没法读。
  const spread = mode === 'book' && stageWidth >= 900;
  const canSpread = (fullscreen ? stageWidth : viewportWidth) >= 900;
  const visibleIndexes = visiblePageIndexes(pageIndex, total, spread);
  const visiblePages = visibleIndexes
    .map((index) => pages[index])
    .filter((page): page is ReaderPage => Boolean(page));
  const lastVisibleIndex = visibleIndexes.length > 0 ? visibleIndexes[visibleIndexes.length - 1] : -1;
  const lastPageIndex = total - 1;
  const onLastPage = visibleIndexes.includes(lastPageIndex);
  const visibleAllRevealed =
    visiblePages.length > 0 && visiblePages.every((page) => revealed.has(page.key));
  const showChoices = Boolean(pending) && onLastPage && visibleAllRevealed;
  const choiceOpen = showChoices && pending?.kind === 'choice' && !choiceCollapsed;
  const inputOpen = showChoices && pending?.kind === 'input';
  // 对开页按「左页先打、右页后打」顺序显示；第一个还没显示完的可见页拿到 active。
  const activePageKey = visiblePages.find((page) => !revealed.has(page.key))?.key ?? null;
  const interactionOpen = inputOpen || choiceOpen;
  const interactionOpenRef = useRef(false);
  interactionOpenRef.current = interactionOpen;

  // 阶段宽度 → 对开页判定（工具页半栏不强行双页；宽屏/全屏才双页）。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? stage.getBoundingClientRect().width;
      setStageWidth(width);
    });
    observer.observe(stage);
    setStageWidth(stage.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // 视口宽度只用于“全屏按钮该不该写双页 / 是否提示可对开”，
  // 不参与 spread 本身（spread 看的是当前舞台实际宽度）。
  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  useEffect(() => {
    onSpreadChange(spread);
  }, [spread, onSpreadChange]);

  // 量正文可用尺寸；分页和最终页面共用同一套排版，所以这里的宽高就是分页依据。
  const reportMetrics = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const el =
      stage.querySelector<HTMLElement>('.cattca-reader__probe .cattca-reader__page-content') ??
      stage.querySelector<HTMLElement>('.cattca-reader__page-content');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) return;
    const style = window.getComputedStyle(el);
    const fontSize = style.fontSize;
    const lineHeight = style.lineHeight;
    const fontFamily = style.fontFamily;
    const key = `${Math.round(rect.width)}x${Math.round(rect.height)}|${fontSize}|${lineHeight}|${fontFamily}`;
    if (key === lastMetricsRef.current) return;
    lastMetricsRef.current = key;
    onMetricsChange({
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fontSize,
      lineHeight,
      fontFamily,
    });
  }, [onMetricsChange]);

  useLayoutEffect(() => {
    reportMetrics();
  }, [reportMetrics, pageIndex, pages.length, mode, fullscreen, stageWidth]);

  // 窗口/手机旋转导致高度变化时重新量高、重新分页；交互面板打开期间跳过，
  // 否则移动端软键盘弹起会把正在输入的页面重排掉。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (interactionOpenRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reportMetrics(), 180);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [reportMetrics]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);

  // 大图会按原始尺寸撑高整页；分页只量一次，图片在量完之后加载就会让页面巨大滚动。
  // 给可见页图片一个基于正文可用高度的 max-height，让图按比例缩到页内。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const apply = () => {
      stage.querySelectorAll<HTMLImageElement>('.cattca-reader__page-content img').forEach((img) => {
        const content = img.closest<HTMLElement>('.cattca-reader__page-content');
        if (!content) return;
        const max = Math.max(120, Math.floor(content.clientHeight * 0.8));
        img.style.maxHeight = `${max}px`;
        img.style.width = 'auto';
        img.style.height = 'auto';
      });
    };
    apply();
    const images = Array.from(stage.querySelectorAll<HTMLImageElement>('img'));
    images.forEach((img) => {
      if (!img.complete) img.addEventListener('load', apply, { once: true });
    });
    return () => {
      images.forEach((img) => img.removeEventListener('load', apply));
    };
  }, [pages, pageIndex, fullscreen, mode, showChoices]);

  useEffect(() => {
    setPageText(String(pageIndex + 1));
  }, [pageIndex]);

  useEffect(() => {
    setChoiceCollapsed(false);
  }, [pending]);

  useEffect(() => {
    if (status === 'error') setLogsOpen(true);
  }, [status]);

  // 选项/输入出现时把焦点放到可操作控件上。
  useEffect(() => {
    if (!showChoices || !pending) return;
    if (pending.kind === 'choice') {
      const first = choiceListRef.current?.querySelector<HTMLButtonElement>('button');
      first?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [showChoices, pending]);

  // 输入/选项面板现在占的是正文下方的独立空间，不再浮在页面上。舞台因此变矮，
  // 把可见页滚到底，保证最后几行正文在面板上方而不是被面板挡住。
  useEffect(() => {
    if (!showChoices) return;
    const stage = stageRef.current;
    if (!stage) return;
    stage.querySelectorAll<HTMLElement>('.cattca-reader__page-content').forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, [showChoices, choiceOpen, inputOpen, pageIndex]);

  const goPrev = useCallback(() => {
    onPageChange(movePage(pageIndex, -1, total, spread));
  }, [onPageChange, pageIndex, total, spread]);

  const goNext = useCallback(() => {
    onPageChange(movePage(pageIndex, 1, total, spread));
  }, [onPageChange, pageIndex, total, spread]);

  const goLatest = useCallback(() => {
    if (total === 0) return;
    onPageChange(spread ? spreadStart(total - 1, true) : total - 1);
  }, [onPageChange, total, spread]);

  // 键盘：←/→ 翻页；选项里 1–9 选择；Shift 加速；Ctrl 单独按一下补完本段。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        if (!isTypingTarget(e.target)) shiftHeldRef.current = true;
        return;
      }
      if (e.key === 'Control') {
        if (!isTypingTarget(e.target)) {
          ctrlComboRef.current = false;
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        ctrlComboRef.current = true;
        return;
      }
      if (isTypingTarget(e.target)) return;

      if (choiceOpen && pending?.kind === 'choice') {
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= pending.options.length) {
          e.preventDefault();
          onChoose(pending.options[n - 1]);
        }
        return;
      }
      if (inputOpen) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'Escape' && fullscreen) {
        e.preventDefault();
        onToggleFullscreen();
      } else if (e.key === 'F11' && variant === 'tool') {
        // 旧工具页的 F11 切换全屏保留；故事页仍用浏览器自己的 F11。
        e.preventDefault();
        onToggleFullscreen();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = false;
        return;
      }
      if (e.key === 'Control') {
        const combo = ctrlComboRef.current;
        ctrlComboRef.current = false;
        if (!combo && !isTypingTarget(e.target)) {
          e.preventDefault();
          onCompleteSegment();
        }
      }
    };

    const onBlur = () => {
      shiftHeldRef.current = false;
      ctrlComboRef.current = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    choiceOpen,
    inputOpen,
    pending,
    fullscreen,
    variant,
    goPrev,
    goNext,
    onChoose,
    onToggleFullscreen,
    onCompleteSegment,
  ]);

  const submitPage = (event: FormEvent) => {
    event.preventDefault();
    const n = Number(pageText);
    if (!Number.isFinite(n)) return;
    const index = clampPage(Math.trunc(n) - 1, total);
    onPageChange(spread ? spreadStart(index, true) : index);
    // 页码输入框保持焦点时按 Ctrl 会被当成“正在输入”，跳页后主动失焦。
    event.currentTarget.querySelector<HTMLInputElement>('.cattca-reader__page-input')?.blur();
  };

  const pageLabel =
    total === 0
      ? '0 / 0'
      : spread && visibleIndexes.length > 1
        ? `${visibleIndexes[0] + 1}–${lastVisibleIndex + 1} / ${total}`
        : `${pageIndex + 1} / ${total}`;

  const rootClass = [
    'cattca-reader',
    `cattca-reader--${mode}`,
    fullscreen ? 'cattca-reader--fullscreen' : '',
    spread ? 'cattca-reader--spread' : 'cattca-reader--one',
    status === 'idle' ? 'cattca-reader--idle' : '',
    status === 'ended' ? 'cattca-reader--ended' : '',
    status === 'error' ? 'cattca-reader--error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      {variant === 'tool' && !fullscreen && (
        <div className="cattca-reader__panel-header">
          <h2 className="story-cattca__panel-title">游戏运行区</h2>
          <button
            type="button"
            className="story-cattca__btn story-cattca__btn--secondary"
            onClick={onToggleFullscreen}
          >
            全屏
          </button>
        </div>
      )}

      {fullscreen && (
        <div className="cattca-reader__panel-header cattca-reader__panel-header--fullscreen">
          <h2 className="cattca-reader__title">
            <BookOpen aria-hidden="true" /> 阅读
          </h2>
          <button
            type="button"
            className="story-cattca__btn story-cattca__btn--secondary"
            onClick={onToggleFullscreen}
          >
            <Minimize2 aria-hidden="true" /> 退出全屏
          </button>
        </div>
      )}

      <div className="cattca-reader__toolbar">
        <div
          className="segmented cattca-reader__mode"
          role="group"
          aria-label="阅读样式"
          style={{ '--seg-n': 2, '--seg-i': mode === 'book' ? 0 : 1 } as CSSProperties}
        >
          <span className="segmented__thumb" aria-hidden="true" />
          <button
            type="button"
            className={'segmented__btn' + (mode === 'book' ? ' is-active' : '')}
            aria-pressed={mode === 'book'}
            onClick={() => onModeChange('book')}
          >
            <BookOpen aria-hidden="true" /> 书本
          </button>
          <button
            type="button"
            className={'segmented__btn' + (mode === 'single' ? ' is-active' : '')}
            aria-pressed={mode === 'single'}
            onClick={() => onModeChange('single')}
          >
            <FileText aria-hidden="true" /> 简洁
          </button>
        </div>
        {mode === 'book' && !spread && canSpread && (
          <span className="cattca-reader__mode-note">全屏可左右对开</span>
        )}

        <div className="cattca-reader__toolbar-group">
          {variant === 'story' && !fullscreen && (
            <button
              type="button"
              className="cattca-reader__text-btn"
              onClick={onToggleFullscreen}
              title={mode === 'book' && canSpread ? '全屏显示左右两页' : '全屏阅读'}
            >
              <Maximize2 aria-hidden="true" />
              {mode === 'book' && canSpread ? '全屏双页' : '全屏'}
            </button>
          )}
          {(logs.length > 0 || status === 'error') && (
            <button
              type="button"
              className="cattca-reader__icon-btn"
              onClick={() => setLogsOpen((open) => !open)}
              aria-label="运行日志"
              aria-expanded={logsOpen}
              title="运行日志"
            >
              <ScrollText aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="cattca-reader__error" role="alert">
          <span>{error}</span>
          {logs.length > 0 && (
            <button
              type="button"
              className="cattca-reader__hint-btn"
              onClick={() => setLogsOpen(true)}
            >
              查看日志
            </button>
          )}
        </div>
      )}

      <div className="cattca-reader__stage" ref={stageRef}>
        {/* 隐藏探针：即使还没有任何页面，也能先量出正文可用尺寸，避免首段先用
            兜底尺寸分页、随后再重排导致文字闪一下。 */}
        <div className="cattca-reader__probe" aria-hidden="true">
          <div className="cattca-reader__page">
            <div className="cattca-reader__page-content" />
            <div className="cattca-reader__page-footer" />
          </div>
        </div>

        {pages.length === 0 ? (
          <div className="cattca-reader__placeholder">
            {status === 'ended' ? (
              <>
                <span>故事已经结束。</span>
                <button
                  type="button"
                  className="cattca-reader__hint-btn"
                  onClick={onRestart}
                >
                  <RotateCcw aria-hidden="true" /> 重新开始
                </button>
              </>
            ) : variant === 'tool' ? (
              '点击左侧「运行脚本」开始。'
            ) : (
              '正在准备…'
            )}
          </div>
        ) : (
          <div className={`cattca-reader__spread ${spread ? 'is-spread' : 'is-single'}`}>
            {visiblePages.map((page, pagePosition) => {
              const side = spread ? (pagePosition === 0 ? 'is-left' : 'is-right') : '';
              return (
                <section
                  className={`cattca-reader__page ${side}`}
                  key={page.key}
                  aria-label={`第 ${page.globalIndex + 1} 页`}
                >
                  <Typewriter
                    key={page.key}
                    html={page.html}
                    pageKey={page.key}
                    initiallyDone={revealed.has(page.key)}
                    active={page.key === activePageKey}
                    shiftHeld={shiftHeldRef}
                    reducedMotion={reducedMotion}
                    onDone={onPageRevealed}
                  />
                  <div className="cattca-reader__page-footer">
                    <span className="cattca-reader__page-number numeric">
                      {page.globalIndex + 1}
                    </span>
                  </div>
                </section>
              );
            })}
            {spread && visiblePages.length === 1 && (
              <section
                className="cattca-reader__page is-right cattca-reader__page--blank"
                aria-hidden="true"
              >
                <div className="cattca-reader__blank-mark">·</div>
                <div className="cattca-reader__page-footer">
                  <span className="cattca-reader__page-number numeric" />
                </div>
              </section>
            )}
          </div>
        )}
      </div>

        <div className="cattca-reader__statusbar">
          {inputOpen && pending?.kind === 'input' ? (
            <form
              className="cattca-reader__inline-input"
              onSubmit={(event) => {
                event.preventDefault();
                const value = inputRef.current?.value ?? '';
                onSubmitInput(value);
              }}
            >
              <label className="cattca-reader__inline-input-label" htmlFor="cattca-reader-input">
                请输入
              </label>
              <input
                id="cattca-reader-input"
                ref={inputRef}
                className="cattca-reader__text-field"
                type="text"
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const value = inputRef.current?.value ?? '';
                    onSubmitInput(value);
                  }
                }}
              />
              <button type="submit" className="cattca-reader__text-submit">
                确定
              </button>
            </form>
          ) : (
            <>
              {pending && !showChoices ? (
                <span className="cattca-reader__status" aria-live="polite">
                  {onLastPage ? '播放中…' : '本段未读完'}
                  {!onLastPage && (
                    <button
                      type="button"
                      className="cattca-reader__hint-link"
                      onClick={onJumpToPending}
                    >
                      {pending.kind === 'choice' ? '跳到选项' : '跳到输入'}
                    </button>
                  )}
                </span>
              ) : pending && showChoices && choiceCollapsed && pending.kind === 'choice' ? (
                <span className="cattca-reader__status">
                  选项已收起
                  <button
                    type="button"
                    className="cattca-reader__hint-link"
                    onClick={() => setChoiceCollapsed(false)}
                  >
                    展开选项
                  </button>
                </span>
              ) : null}

              <span className="cattca-reader__status-keys">
                <span>
                  <kbd>Shift</kbd> 加速
                </span>
                <span>
                  <kbd>Ctrl</kbd> 跳过
                </span>
              </span>
            </>
          )}
        </div>

        {choiceOpen && pending?.kind === 'choice' && (
          <div className="cattca-reader__choice-sheet" role="dialog" aria-label="选择">
            <div className="cattca-reader__choice-head">
              <div className="cattca-reader__choice-title">你要怎么做？</div>
              <button
                type="button"
                className="cattca-reader__choice-collapse"
                onClick={() => setChoiceCollapsed(true)}
              >
                收起
              </button>
            </div>
            <div className="cattca-reader__choice-list" ref={choiceListRef}>
              {pending.options.map((option, index) => (
                <button
                  type="button"
                  className="cattca-reader__choice-btn"
                  key={`${index}-${option}`}
                  onClick={() => onChoose(option)}
                >
                  <span className="cattca-reader__choice-index numeric">{index + 1}</span>
                  <span className="cattca-reader__choice-text">{option}</span>
                </button>
              ))}
            </div>
            <div className="cattca-reader__choice-hint">
              点击选项，或按数字键 1–{Math.min(9, pending.options.length)}
            </div>
          </div>
        )}

        {status === 'ended' && pages.length > 0 && (
          <div className="cattca-reader__end">
            <span>—— 完 ——</span>
            <button type="button" className="cattca-reader__hint-btn" onClick={onRestart}>
              <RotateCcw aria-hidden="true" /> 重新开始
            </button>
          </div>
        )}

      <div className="cattca-reader__footer">
        <button
          type="button"
          className="cattca-reader__nav-btn"
          onClick={goPrev}
          disabled={total === 0 || spreadStart(pageIndex, spread) <= 0}
          aria-label="上一页"
          title="上一页"
        >
          <ChevronLeft aria-hidden="true" />
        </button>

        <span className="cattca-reader__page-indicator numeric">{pageLabel}</span>

        <form className="cattca-reader__page-form" onSubmit={submitPage}>
          <label className="cattca-reader__page-label" htmlFor="cattca-reader-page">
            跳至
          </label>
          <input
            id="cattca-reader-page"
            className="cattca-reader__page-input numeric"
            type="number"
            min={1}
            max={Math.max(1, total)}
            value={pageText}
            onChange={(event) => setPageText(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            disabled={total === 0}
            aria-label="跳转到页码"
          />
          <span className="cattca-reader__page-total numeric">/ {total}</span>
        </form>

        <button
          type="button"
          className="cattca-reader__nav-btn"
          onClick={goNext}
          disabled={total === 0 || lastVisibleIndex >= lastPageIndex}
          aria-label="下一页"
          title="下一页"
        >
          <ChevronRight aria-hidden="true" />
        </button>

        <button
          type="button"
          className="cattca-reader__latest-btn"
          onClick={goLatest}
          disabled={total === 0 || pageIndex >= lastPageIndex}
        >
          最新
        </button>
      </div>

      {logsOpen && (
        <div className="cattca-reader__logs" role="log" aria-label="运行日志">
          <pre className="cattca-reader__log">{logs.join('\n') || '（无日志）'}</pre>
        </div>
      )}
    </div>
  );
}
