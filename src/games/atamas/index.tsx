'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ATÅMAS — 顶层客户端组件（组合 engine + render + i18n）
//
// 画布操作交给独立引擎；React 展示快照并负责重置、撤销、预览与语言切换。
//   • 引擎通过 onSnapshot 回调把分数 / 最大值 / 消息 / 当前动作 / 预览队列 /
//     撤销按钮状态推给 React；警示灯由 elementCount 按原逻辑推导。
// 页面外壳使用站点主题，数字圆盘保留游戏自己的配色。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Flag,
  RotateCcw,
  Target,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { AtamasRingIcon } from './icons';
import type { AtamasUiSnapshot, MessageKind } from './constants';
import { BASECOLORS, FRONTCOLORS } from './constants';
import { AtamasEngine } from './engine';
import {
  TRANSLATIONS,
  getTranslation,
  setCurrentLang,
  detectInitialLang,
  sortedLanguageCodes,
} from './i18n';

const EMPTY_SNAPSHOT: AtamasUiSnapshot = {
  score: 0,
  maxPlate: 0,
  elementCount: 0,
  preview: [null, null, null],
  recall: { disabled: true, text: 'Undo', title: '' },
  message: '',
  messageKind: 'plain',
  currentAction: '',
};

// 状态消息 → 图标（引擎只推纯文本 + kind，图标在渲染层配）
const MSG_ICON: Partial<Record<MessageKind, React.ReactNode>> = {
  gameOver: <Flag aria-hidden="true" />,
  merge: <CircleCheck aria-hidden="true" />,
  recall: <Undo2 aria-hidden="true" />,
  reset: <RotateCcw aria-hidden="true" />,
  warn: <TriangleAlert aria-hidden="true" />,
};

// 警示灯类名（对齐 updateWarningLights）：18→3 绿，19→2 黄，≥20→1 红
function warningClasses(count: number): string[] {
  const cls = ['', '', ''];
  if (count >= 18) {
    if (count <= 18) {
      for (let i = 0; i < 3; i++) cls[i] = 'green';
    } else if (count <= 19) {
      for (let i = 0; i < 2; i++) cls[i] = 'yellow';
    } else {
      cls[0] = 'red';
    }
  }
  return cls;
}

export default function Atamas({
  initialLang = null,
  backHref,
  backLabel = '返回',
}: {
  /** 首屏语言（合法语言码）。不传则由 localStorage / 浏览器语言探测决定。 */
  initialLang?: string | null;
  /** 传了就渲染一个返回链接（宿主自己的路由）；不传则不渲染。 */
  backHref?: string;
  backLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<AtamasEngine | null>(null);

  const [snap, setSnap] = useState<AtamasUiSnapshot>(EMPTY_SNAPSHOT);
  const [lang, setLang] = useState(initialLang ?? 'en');
  const [langOpen, setLangOpen] = useState(false);
  const [previewHidden, setPreviewHidden] = useState(false);

  // 挂载：建引擎、启动、读偏好
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 语言：LS 显式偏好权威，其次宿主传入的 prop；两者皆无（首次访问）
    // 才退回浏览器探测。
    let storedLang: string | null = null;
    try {
      const v = localStorage.getItem('atamas_lang');
      if (v && TRANSLATIONS[v]) storedLang = v;
    } catch {
      /* ignore */
    }
    const initial = storedLang ?? (initialLang && TRANSLATIONS[initialLang] ? initialLang : detectInitialLang());
    setCurrentLang(initial);
    setLang(initial);

    const engine = new AtamasEngine(canvas, ctx, { onSnapshot: setSnap });
    engineRef.current = engine;
    engine.initGame();
    engine.start();

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.atamas-language-select')) setLangOpen(false);
    };
    document.addEventListener('click', onDocClick);

    return () => {
      document.removeEventListener('click', onDocClick);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // 交互回调
  const onCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    engineRef.current?.handleClick(e.clientX, e.clientY);
  }, []);
  const onCanvasMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') return;
    engineRef.current?.handleMouseMove(e.clientX, e.clientY);
  }, []);
  const onCanvasLeave = useCallback(() => {
    engineRef.current?.handleMouseLeave();
  }, []);

  const changeLang = useCallback((code: string) => {
    if (!TRANSLATIONS[code]) return;
    setCurrentLang(code);
    setLang(code);
    engineRef.current?.requestRedraw();
    setLangOpen(false);
  }, []);

  // lang 变化触发重渲染，界面文案经 getTranslation(currentLang) 重新读取
  const warn = warningClasses(snap.elementCount);
  const activeName = TRANSLATIONS[lang]?.name ?? 'English';
  const activeFont = TRANSLATIONS[lang]?.font;
  const t = (key: string) => getTranslation(key, lang);

  return (
    <div className="game-atamas-page" id="atamasPage" onKeyDown={(e) => { if (e.key === 'Escape') setLangOpen(false); }}>
      <div className="game-atamas-wrapper">
        {backHref && (
          <a href={backHref} className="game-atamas-back">
            <ArrowLeft aria-hidden="true" /> {backLabel}
          </a>
        )}

        <div className="atamas-container">
          {/* Top Bar */}
          <div className="atamas-top-bar">
            <h1 className="atamas-top-bar__title" style={{ fontFamily: activeFont }}>
              <AtamasRingIcon />
              {t('title')}
            </h1>
            <div className="atamas-top-bar__actions">
              <div className={`atamas-language-select${langOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="atamas-language-btn"
                  aria-expanded={langOpen}
                  aria-controls="atamas-languages"
                  aria-label="选择语言"
                  style={{ fontFamily: activeFont }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLangOpen((v) => !v);
                  }}
                >
                  <span>{activeName}</span>
                  <span className="arrow" aria-hidden="true">
                    <ChevronDown />
                  </span>
                </button>
                <div className="atamas-language-dropdown" id="atamas-languages">
                  {sortedLanguageCodes().map((code) => (
                    <button
                      key={code}
                      type="button"
                      className={`atamas-language-option${code === lang ? ' is-active' : ''}`}
                      aria-pressed={code === lang}
                      style={{ fontFamily: TRANSLATIONS[code].font }}
                      onClick={() => changeLang(code)}
                    >
                      {TRANSLATIONS[code].name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="atamas-canvas-wrapper">
            <canvas
              className="atamas-canvas"
              width={500}
              height={500}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasMove}
              onPointerLeave={onCanvasLeave}
              aria-label="ATÅMAS 游戏棋盘"
              ref={canvasRef}
            />
            <div className="atamas-pending-preview-wrapper">
              <button
                type="button"
                className="atamas-preview-toggle-btn"
                title={previewHidden ? t('showPreview') : t('hidePreview')}
                onClick={() => setPreviewHidden((v) => !v)}
              >
                {previewHidden ? '<' : '>'}
              </button>
              <div className={`atamas-pending-preview${previewHidden ? ' hidden' : ''}`}>
                <div className="atamas-pending-preview__label">{t('next')}</div>
                {snap.preview.map((el, i) => {
                  let cls = 'atamas-pending-ball empty';
                  let text = '?';
                  const style: React.CSSProperties = {
                    background: 'rgba(60, 96, 128, 0.3)',
                    color: 'rgba(255,255,255,0.3)',
                  };
                  if (el && el.type === 'number') {
                    const idx = ((el.value ?? 1) - 1) % BASECOLORS.length;
                    cls = 'atamas-pending-ball number';
                    text = String(el.value);
                    style.background = BASECOLORS[idx];
                    style.color = FRONTCOLORS[idx];
                    style.border = '2px solid rgba(255, 255, 255, 0.4)';
                  } else if (el) {
                    cls = 'atamas-pending-ball plus';
                    text = '+';
                    if (el.isBlackGolden) {
                      style.background = '#1a1a1a';
                      style.color = '#ffd700';
                      style.border = '2px solid #ffd700';
                    } else {
                      style.background = '#ffd700';
                      style.color = '#1e2f44';
                    }
                  }
                  return (
                    <div key={i} className={`${cls} numeric`} style={style}>
                      {text}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="atamas-info-panel">
            <button
              type="button"
              className="atamas-btn atamas-btn--secondary"
              style={{ fontFamily: activeFont }}
              onClick={() => engineRef.current?.reset()}
            >
              <RotateCcw aria-hidden="true" /> {t('reset')}
            </button>
            <button
              type="button"
              className="atamas-btn atamas-btn--secondary"
              style={{ fontFamily: activeFont }}
              title={snap.recall.title}
              disabled={snap.recall.disabled}
              onClick={() => engineRef.current?.recall()}
            >
              <Undo2 aria-hidden="true" /> {snap.recall.text}
            </button>
            <div className="atamas-turn-info" style={{ fontFamily: activeFont }}>
              <span className="atamas-turn-info__icon" aria-hidden="true">
                <Target />
              </span>
              <strong>{snap.currentAction}</strong>
            </div>
          </div>

          <div className="atamas-message" role="status" style={{ fontFamily: activeFont }}>
            {MSG_ICON[snap.messageKind] && (
              <span className="atamas-message__icon" aria-hidden="true">
                {MSG_ICON[snap.messageKind]}
              </span>
            )}
            {snap.message && <span>{snap.message}</span>}
          </div>

          {/* Bottom Bar */}
          <div className="atamas-bottom-bar">
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {t('maxPlate')}
              </span>
              <span className="atamas-bottom-bar__value max-number numeric">{snap.maxPlate}</span>
            </div>
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {t('score')}
              </span>
              <span className="atamas-bottom-bar__value numeric">{snap.score}</span>
            </div>
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {t('warning')}
              </span>
              <div className="atamas-warning-lights">
                {warn.map((c, i) => (
                  <div key={i} className={`atamas-warning-dot${c ? ' ' + c : ''}`} />
                ))}
              </div>
            </div>
          </div>

          <div className="atamas-attribution">
            An imitation of ATOMAS -- Thanks ATOMAS for the inspiration.
          </div>
        </div>
      </div>
    </div>
  );
}

