'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CattcaPlayer — 互动小说 Cattca 引擎的 React 宿主。
//
// 忠实移植 Flask 侧两个 runner：
//   • app/templates/story/cattca.html（.story-cattca 输出 + 可折叠段落 + 选项/输入）
//   • app/templates/tool/cattca.html（同一套逻辑，类名前缀 cattca__；额外含全屏模式）
//
// 解释器本体在 public/static/js/cattca.js（ESM，导出 class CattcaInterpreter）。
// 该文件不参与 Next 打包——通过动态注入的 <script type="module"> 引入并挂到
// window，再读回构造器（任务允许的方式，且能在 Next 15 下干净通过类型检查）。
// marked / DOMPurify 走 npm 依赖（与 MarkdownRenderer 同一套库）。
//
// tool 变体额外承载：游戏运行区标题栏 + 全屏按钮 + 全屏覆盖层，全屏内容通过
// innerHTML 镜像同步（与 Flask cattca.html 的 syncToFullscreen 一致）。全屏切换
// 通过 forwardRef 暴露给页面，供 Ctrl+F 快捷键调用。
// ─────────────────────────────────────────────────────────────────────────────

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ── 解释器类型（cattca.js 是纯 JS，这里给出最小构造签名） ──────────────────────

interface CattcaInterpreterInstance {
  load(source: string): void;
  run(): Promise<void>;
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

// ── 变体配置：story / tool 两套类名（对齐两份模板） ───────────────────────────

type Variant = 'story' | 'tool';

interface VariantConfig {
  prefix: string;
  segment: string;
  header: string;
  title: string;
  toggle: string;
  body: string;
  collapsed: string;
  inputArea: string;
  inputSubmit: string;
  choiceBtn: string;
}

const CONFIGS: Record<Variant, VariantConfig> = {
  story: {
    prefix: 'story-cattca',
    segment: 'story-cattca__segment',
    header: 'story-cattca__segment-header',
    title: 'story-cattca__segment-title',
    toggle: 'story-cattca__segment-toggle',
    body: 'story-cattca__segment-body',
    collapsed: 'collapsed',
    inputArea: 'story-cattca__input-area',
    inputSubmit: '',
    choiceBtn: '',
  },
  tool: {
    prefix: 'cattca',
    segment: 'cattca__segment',
    header: 'cattca__segment-header',
    title: 'cattca__segment-title',
    toggle: 'cattca__segment-toggle',
    body: 'cattca__segment-content',
    collapsed: 'cattca__segment-content--collapsed',
    inputArea: 'cattca__input-prompt',
    inputSubmit: 'cattca__input-submit',
    choiceBtn: 'cattca__choice-btn',
  },
};

// ── 组件 ────────────────────────────────────────────────────────────────────

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
  // tool 变体：运行结束/出错时向页面回报状态（对齐 Flask 的“运行完成 / 运行出错”）。
  onStatus?: (text: string, type: 'ready' | 'running' | 'error') => void;
}

const CattcaPlayer = forwardRef<CattcaPlayerHandle, CattcaPlayerProps>(function CattcaPlayer(
  { script, variant = 'story', runId, onStatus },
  ref,
) {
  const isTool = variant === 'tool';

  const outputRef = useRef<HTMLDivElement>(null);
  const choicesRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // 全屏相关（仅 tool 变体渲染这些容器）。
  const fsOutputRef = useRef<HTMLDivElement>(null);
  const fsChoicesRef = useRef<HTMLDivElement>(null);
  const fsLogRef = useRef<HTMLDivElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreenRef = useRef(false);

  // 跨 effect 桥接：syncToFullscreen 由 runner effect 定义，全屏进入时调用；
  // startNewSegment / 当前选项 resolver 供全屏选项按钮点击时推进解释器。
  const syncToFullscreenRef = useRef<(() => void) | null>(null);
  const startNewSegmentRef = useRef<(() => void) | null>(null);
  const currentChoiceResolverRef = useRef<((v: string) => void) | null>(null);

  const setFullscreen = useCallback((on: boolean) => {
    isFullscreenRef.current = on;
    setIsFullscreen(on);
    if (typeof document !== 'undefined') {
      document.body.style.overflow = on ? 'hidden' : '';
    }
    if (on) syncToFullscreenRef.current?.();
  }, []);

  const toggleFullscreen = useCallback(() => {
    setFullscreen(!isFullscreenRef.current);
  }, [setFullscreen]);

  useImperativeHandle(
    ref,
    () => ({
      toggleFullscreen,
      enterFullscreen: () => setFullscreen(true),
      exitFullscreen: () => setFullscreen(false),
    }),
    [toggleFullscreen, setFullscreen],
  );

  // 全屏全局快捷键：Esc 退出、F11 切换（对齐 Flask 的 document 级监听）。
  useEffect(() => {
    if (!isTool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreenRef.current) {
        e.preventDefault();
        setFullscreen(false);
      }
      if (e.key === 'F11') {
        e.preventDefault();
        setFullscreen(!isFullscreenRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isTool, setFullscreen]);

  // 运行器：装载解释器并把输出/日志/选项/输入渲染到容器。
  useEffect(() => {
    const cfg = CONFIGS[variant];
    const outputDiv = outputRef.current;
    const choicesDiv = choicesRef.current;
    const logDiv = logRef.current;
    if (!outputDiv || !choicesDiv || !logDiv) return;

    let cancelled = false;

    // marked 配置（对齐两份 runner：breaks + gfm）。
    marked.setOptions({ breaks: true, gfm: true });

    // 可折叠输出系统 —— 与模板逐字节对齐的本地可变状态。
    let currentSegment: HTMLDivElement | null = null;
    let segmentCount = 0;
    let outputBuffer = '';

    const renderMarkdown = (buffer: string): string => {
      try {
        const raw = marked.parse(buffer, { async: false }) as string;
        return DOMPurify.sanitize(raw);
      } catch (error) {
        console.error('Markdown parsing error:', error);
        return buffer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
    };

    // 全屏选项按钮重新绑定：点击时清空选项、开新段落、推进解释器。
    const bindFullscreenChoiceEvents = () => {
      const fsChoices = fsChoicesRef.current;
      if (!fsChoices) return;
      fsChoices.querySelectorAll('button').forEach((btn) => {
        (btn as HTMLButtonElement).onclick = () => {
          const choiceText = (btn as HTMLButtonElement).innerText;
          choicesDiv.innerHTML = '';
          fsChoices.innerHTML = '';
          startNewSegment();
          currentChoiceResolverRef.current?.(choiceText);
        };
      });
    };

    // 进入全屏时把主区内容镜像到全屏区。
    const syncToFullscreen = () => {
      const fsOutput = fsOutputRef.current;
      const fsLog = fsLogRef.current;
      const fsChoices = fsChoicesRef.current;
      if (!fsOutput || !fsLog || !fsChoices) return;
      fsOutput.innerHTML = outputDiv.innerHTML;
      fsLog.textContent = logDiv.textContent;
      if (choicesDiv.children.length > 0 && fsChoices.children.length === 0) {
        fsChoices.innerHTML = choicesDiv.innerHTML;
        bindFullscreenChoiceEvents();
      }
    };
    syncToFullscreenRef.current = syncToFullscreen;

    // 将缓冲区整体渲染到当前段落（不存在则新建可折叠段落）。
    const flushOutput = () => {
      if (outputBuffer === '' || cancelled) return;
      const htmlContent = renderMarkdown(outputBuffer);

      if (!currentSegment) {
        const segment = document.createElement('div');
        segment.className = cfg.segment;

        const header = document.createElement('div');
        header.className = cfg.header;
        header.onclick = () => toggleSegment(header);

        const title = document.createElement('span');
        title.className = cfg.title;
        title.textContent = '段落 ' + ++segmentCount;

        const icon = document.createElement('span');
        icon.className = cfg.toggle;
        icon.textContent = '▼';

        header.appendChild(title);
        header.appendChild(icon);

        const body = document.createElement('div');
        body.className = cfg.body;
        body.innerHTML = htmlContent;

        segment.appendChild(header);
        segment.appendChild(body);
        outputDiv.appendChild(segment);
        currentSegment = segment;

        window.setTimeout(() => {
          if (cancelled || !currentSegment) return;
          const rect = currentSegment.getBoundingClientRect();
          const containerRect = outputDiv.getBoundingClientRect();
          const scrollTop = outputDiv.scrollTop + (rect.top - containerRect.top) - 20;
          outputDiv.scrollTo({ top: scrollTop, behavior: 'smooth' });
        }, 10);
      } else {
        const body = currentSegment.querySelector('.' + cssEscape(cfg.body));
        if (body) body.innerHTML = htmlContent;
      }
      outputDiv.scrollTop = outputDiv.scrollHeight;

      if (isFullscreenRef.current && fsOutputRef.current) {
        fsOutputRef.current.innerHTML = outputDiv.innerHTML;
        fsOutputRef.current.scrollTop = fsOutputRef.current.scrollHeight;
        if (choicesDiv.children.length > 0 && fsChoicesRef.current) {
          fsChoicesRef.current.innerHTML = choicesDiv.innerHTML;
          bindFullscreenChoiceEvents();
        }
      }
    };

    // 仅累积文本，段落边界再统一 flush。
    const appendOutput = (txt: string) => {
      outputBuffer += txt;
    };

    const startNewSegment = () => {
      if (currentSegment) {
        const body = currentSegment.querySelector('.' + cssEscape(cfg.body));
        if (body) body.classList.add(cfg.collapsed);
      }
      currentSegment = null;
      outputBuffer = '';
      if (isFullscreenRef.current && fsOutputRef.current) {
        fsOutputRef.current.innerHTML = outputDiv.innerHTML;
      }
    };
    startNewSegmentRef.current = startNewSegment;

    const toggleSegment = (header: HTMLElement) => {
      const segment = header.parentElement;
      if (!segment) return;
      const body = segment.querySelector('.' + cssEscape(cfg.body));
      const icon = header.querySelector('.' + cssEscape(cfg.toggle));
      if (!body || !icon) return;
      if (body.classList.contains(cfg.collapsed)) {
        body.classList.remove(cfg.collapsed);
        icon.textContent = '▲';
      } else {
        body.classList.add(cfg.collapsed);
        icon.textContent = '▼';
      }
    };

    const appendLog = (txt: string) => {
      logDiv.textContent += txt + '\n';
      logDiv.scrollTop = logDiv.scrollHeight;
      if (isFullscreenRef.current && fsLogRef.current) {
        fsLogRef.current.textContent = logDiv.textContent;
        fsLogRef.current.scrollTop = fsLogRef.current.scrollHeight;
      }
    };

    // 选项：flush 后渲染按钮，点击推进解释器（全屏时同步渲染一份全屏按钮）。
    const getChoice = (options: string[]): Promise<string> =>
      new Promise((resolve) => {
        flushOutput();
        choicesDiv.innerHTML = '';
        if (fsChoicesRef.current) fsChoicesRef.current.innerHTML = '';

        options.forEach((opt) => {
          const btn = document.createElement('button');
          if (cfg.choiceBtn) btn.className = cfg.choiceBtn;
          btn.textContent = opt;
          btn.onclick = () => {
            choicesDiv.innerHTML = '';
            if (fsChoicesRef.current) fsChoicesRef.current.innerHTML = '';
            startNewSegment();
            resolve(opt);
          };
          choicesDiv.appendChild(btn);

          if (isFullscreenRef.current && fsChoicesRef.current) {
            const fsBtn = document.createElement('button');
            if (cfg.choiceBtn) fsBtn.className = cfg.choiceBtn;
            fsBtn.textContent = opt;
            fsBtn.onclick = () => {
              choicesDiv.innerHTML = '';
              if (fsChoicesRef.current) fsChoicesRef.current.innerHTML = '';
              startNewSegment();
              resolve(opt);
            };
            fsChoicesRef.current.appendChild(fsBtn);
          }
        });

        currentChoiceResolverRef.current = resolve;
      });

    // 文本输入：flush 后插入输入行，确定/回车提交（全屏时复制一份到全屏区）。
    const getInput = (promptText: string): Promise<string> =>
      new Promise((resolve) => {
        flushOutput();
        const area = document.createElement('div');
        area.className = cfg.inputArea;

        const label = document.createElement('label');
        label.textContent = promptText || '请输入:';

        const input = document.createElement('input');
        input.type = 'text';

        const btn = document.createElement('button');
        if (cfg.inputSubmit) btn.className = cfg.inputSubmit;
        btn.textContent = '确定';

        area.appendChild(label);
        area.appendChild(input);
        area.appendChild(btn);
        outputDiv.appendChild(area);

        let fsArea: HTMLElement | null = null;
        const fsOutput = fsOutputRef.current;
        if (isFullscreenRef.current && fsOutput) {
          fsArea = area.cloneNode(true) as HTMLElement;
          fsOutput.appendChild(fsArea);
          const fsInput = fsArea.querySelector('input') as HTMLInputElement | null;
          const fsButton = fsArea.querySelector('button') as HTMLButtonElement | null;
          if (fsInput && fsButton) {
            fsInput.focus();
            const handleFullscreenSubmit = () => {
              const value = fsInput.value;
              if (fsArea && fsArea.parentElement === fsOutput) {
                fsOutput.removeChild(fsArea);
              }
              if (area.parentElement === outputDiv) outputDiv.removeChild(area);
              startNewSegment();
              resolve(value);
            };
            fsButton.onclick = handleFullscreenSubmit;
            fsInput.onkeypress = (e) => {
              if (e.key === 'Enter' && !e.isComposing) handleFullscreenSubmit();
            };
          }
        } else {
          input.focus();
        }

        const handleSubmit = () => {
          const value = input.value;
          if (fsArea && fsOutput && fsArea.parentElement === fsOutput) {
            fsOutput.removeChild(fsArea);
          }
          if (area.parentElement === outputDiv) outputDiv.removeChild(area);
          startNewSegment();
          resolve(value);
        };
        btn.onclick = handleSubmit;
        input.onkeypress = (e) => {
          if (e.key === 'Enter' && !e.isComposing) handleSubmit();
        };
      });

    // 启动：清空容器 → 加载解释器 → run() → 结束 flush 剩余缓冲。
    const shouldRun = !isTool || (runId ?? 0) > 0;

    outputDiv.innerHTML = '';
    choicesDiv.innerHTML = '';
    logDiv.textContent = '';
    if (fsOutputRef.current) fsOutputRef.current.innerHTML = '';
    if (fsChoicesRef.current) fsChoicesRef.current.innerHTML = '';
    if (fsLogRef.current) fsLogRef.current.textContent = '';

    if (shouldRun) {
      loadCattca()
        .then((Ctor) => {
          if (cancelled) return;
          const interpreter = new Ctor(appendOutput, appendLog, getInput, getChoice);
          interpreter.load(script ?? '');
          return interpreter.run().then(() => {
            if (cancelled) return;
            flushOutput();
            onStatus?.('运行完成', 'ready');
          });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          appendLog('错误: ' + message);
          onStatus?.('运行出错', 'error');
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, variant, runId, isTool]);

  const cfg = CONFIGS[variant];

  if (!isTool) {
    return (
      <>
        <div className={`${cfg.prefix}__output`} ref={outputRef}></div>
        <div className={`${cfg.prefix}__choices`} ref={choicesRef}></div>
        <div className={`${cfg.prefix}__log`} ref={logRef}></div>
      </>
    );
  }

  return (
    <>
      <div className="cattca__game-header">
        <h2 className="cattca__panel-title">游戏运行区</h2>
        <button className="cattca__btn cattca__btn--secondary" onClick={toggleFullscreen}>
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>
      <div className="cattca__output" ref={outputRef}></div>
      <div className="cattca__choices" ref={choicesRef}></div>
      <div className="cattca__log" ref={logRef}></div>

      <div
        className={
          'cattca__fullscreen' + (isFullscreen ? ' cattca__fullscreen--open' : '')
        }
      >
        <div className="cattca__fullscreen-header">
          <h2 className="cattca__panel-title">游戏运行区 - 全屏模式</h2>
          <button className="cattca__exit-fullscreen-btn" onClick={() => setFullscreen(false)}>
            退出全屏
          </button>
        </div>
        <div className="cattca__fullscreen-content">
          <div className="cattca__fullscreen-output" ref={fsOutputRef}></div>
          <div className="cattca__fullscreen-choices" ref={fsChoicesRef}></div>
          <div className="cattca__fullscreen-log" ref={fsLogRef}></div>
        </div>
      </div>
    </>
  );
});

export default CattcaPlayer;

// 段落 body / toggle 类名固定为安全的 BEM 标识符，此处仅做防御式转义，
// 避免类名里出现的特殊字符破坏 querySelector 选择器。
function cssEscape(cls: string): string {
  return cls.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
