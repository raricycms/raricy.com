'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ATÅMAS — 顶层客户端组件（组合 engine + render + i18n）
//
// 对齐 Flask 侧 atamas.html 的 DOM 结构与 main.js 的启动/交互：
//   • 画布点击/悬停/触摸 → 引擎放置元素；Reset / Recall / 预览开合 / 主题切换 /
//     语言下拉，均复刻原站行为。
//   • 引擎通过 onSnapshot 回调把分数 / 最大值 / 消息 / 当前动作 / 预览队列 /
//     撤销按钮状态推给 React；警示灯由 elementCount 按原逻辑推导。
//   • 主题与站点全局 data-theme 同步（light → .light-mode），并监听外部切换。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AtamasUiSnapshot } from './constants';
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
  recall: { disabled: true, text: '↩ Recall', title: '' },
  message: '',
  currentAction: '',
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

export default function Atamas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<AtamasEngine | null>(null);

  const [snap, setSnap] = useState<AtamasUiSnapshot>(EMPTY_SNAPSHOT);
  const [lang, setLang] = useState('en');
  const [langOpen, setLangOpen] = useState(false);
  const [lightMode, setLightMode] = useState(true);
  const [previewHidden, setPreviewHidden] = useState(false);

  // 挂载：建引擎、启动、监听主题
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const initial = detectInitialLang();
    setCurrentLang(initial);
    setLang(initial);
    if (typeof document !== 'undefined') document.documentElement.lang = initial;

    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    setLightMode(theme === 'light');

    const engine = new AtamasEngine(canvas, ctx, { onSnapshot: setSnap });
    engineRef.current = engine;
    engine.initGame();
    engine.start();

    const observer = new MutationObserver(() => {
      const t = document.documentElement.getAttribute('data-theme') || 'light';
      setLightMode(t === 'light');
      engine.requestRedraw();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.atamas-language-select')) setLangOpen(false);
    };
    document.addEventListener('click', onDocClick);

    return () => {
      observer.disconnect();
      document.removeEventListener('click', onDocClick);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // 交互回调
  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    engineRef.current?.handleClick(e.clientX, e.clientY);
  }, []);
  const onCanvasMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    engineRef.current?.handleMouseMove(e.clientX, e.clientY);
  }, []);
  const onCanvasLeave = useCallback(() => {
    engineRef.current?.handleMouseLeave();
  }, []);
  const onCanvasTouch = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) engineRef.current?.handleClick(t.clientX, t.clientY);
  }, []);

  const changeLang = useCallback((code: string) => {
    if (!TRANSLATIONS[code]) return;
    setCurrentLang(code);
    setLang(code);
    if (typeof document !== 'undefined') document.documentElement.lang = code;
    engineRef.current?.requestRedraw();
    setLangOpen(false);
  }, []);

  const toggleTheme = useCallback(() => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* ignore */
    }
    setLightMode(next === 'light');
    engineRef.current?.requestRedraw();
  }, []);

  // lang 变化触发重渲染，界面文案经 getTranslation(currentLang) 重新读取
  const warn = warningClasses(snap.elementCount);
  const activeName = TRANSLATIONS[lang]?.name ?? 'English';
  const activeFont = TRANSLATIONS[lang]?.font;

  return (
    <div className={`game-atamas-page${lightMode ? ' light-mode' : ''}`} id="atamasPage">
      <style>{ATAMAS_CSS}</style>
      <div className="game-atamas-wrapper">
        <Link href="/game" className="game-atamas-back">
          ← 返回玩具
        </Link>

        <div className="atamas-container">
          {/* Top Bar */}
          <div className="atamas-top-bar">
            <h1 className="atamas-top-bar__title" style={{ fontFamily: activeFont }}>
              {getTranslation('title')}
            </h1>
            <div className="atamas-top-bar__actions">
              <div className={`atamas-language-select${langOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="atamas-language-btn"
                  style={{ fontFamily: activeFont }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLangOpen((v) => !v);
                  }}
                >
                  <span>{activeName}</span>
                  <span className="arrow">▼</span>
                </button>
                <div className="atamas-language-dropdown">
                  {sortedLanguageCodes().map((code) => (
                    <div
                      key={code}
                      className={`atamas-language-option${code === lang ? ' active' : ''}`}
                      style={{ fontFamily: TRANSLATIONS[code].font }}
                      onClick={() => changeLang(code)}
                    >
                      {TRANSLATIONS[code].name}
                    </div>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="atamas-top-bar-btn"
                style={{ fontFamily: activeFont }}
                onClick={toggleTheme}
              >
                {lightMode ? getTranslation('darkMode') : getTranslation('lightMode')}
              </button>
            </div>
          </div>

          <div className="atamas-canvas-wrapper">
            <canvas
              className="atamas-canvas"
              width={500}
              height={500}
              onClick={onCanvasClick}
              onMouseMove={onCanvasMove}
              onMouseLeave={onCanvasLeave}
              onTouchStart={onCanvasTouch}
              ref={canvasRef}
            />
            <div className="atamas-pending-preview-wrapper">
              <button
                type="button"
                className="atamas-preview-toggle-btn"
                title={previewHidden ? getTranslation('showPreview') : getTranslation('hidePreview')}
                onClick={() => setPreviewHidden((v) => !v)}
              >
                {previewHidden ? '<' : '>'}
              </button>
              <div className={`atamas-pending-preview${previewHidden ? ' hidden' : ''}`}>
                <div className="atamas-pending-preview__label">{getTranslation('next')}</div>
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
                    <div key={i} className={cls} style={style}>
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
              {getTranslation('reset')}
            </button>
            <button
              type="button"
              className="atamas-btn atamas-btn--secondary"
              style={{ fontFamily: activeFont }}
              title={snap.recall.title}
              disabled={snap.recall.disabled}
              onClick={() => engineRef.current?.recall()}
            >
              {snap.recall.text}
            </button>
            <div className="atamas-turn-info" style={{ fontFamily: activeFont }}>
              🎯 <strong>{snap.currentAction}</strong>
            </div>
          </div>

          <div
            className="atamas-message"
            style={{ fontFamily: activeFont }}
            dangerouslySetInnerHTML={{ __html: snap.message }}
          />

          {/* Bottom Bar */}
          <div className="atamas-bottom-bar">
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {getTranslation('maxPlate')}
              </span>
              <span className="atamas-bottom-bar__value max-number">{snap.maxPlate}</span>
            </div>
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {getTranslation('score')}
              </span>
              <span className="atamas-bottom-bar__value">{snap.score}</span>
            </div>
            <div className="atamas-bottom-bar__item">
              <span className="atamas-bottom-bar__label" style={{ fontFamily: activeFont }}>
                {getTranslation('warning')}
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

// 自包含样式（从 Flask 侧 pages/game/_atamas.scss 展平；light-mode 走 .game-atamas-page.light-mode）
const ATAMAS_CSS = `
.game-atamas-page {
  background: #0f1a2b; min-height: calc(100vh - 60px);
  display: flex; justify-content: center; align-items: flex-start;
  padding: 16px; transition: background 0.3s ease;
}
.game-atamas-page.light-mode { background: #e8f4f8; }
.game-atamas-back {
  display: inline-block; color: #8ab4d6; text-decoration: none;
  font-size: 0.9rem; margin-bottom: 1rem; transition: color 0.2s;
  font-family: 'Bahnschrift', 'Cascadia Code', 'Segoe UI', sans-serif;
}
.game-atamas-back:hover { color: #d6e6ff; }
.game-atamas-wrapper { display: flex; flex-direction: column; align-items: center; width: 100%; }
.atamas-container {
  background: #1e2f44; border-radius: 54px; padding: 18px 27px;
  box-shadow: 0 18px 36px rgba(0,0,0,0.6); max-width: 855px; width: 100%;
  transition: background 0.3s ease, box-shadow 0.3s ease;
}
.game-atamas-page.light-mode .atamas-container {
  background: #ffffff; box-shadow: 0 20px 40px rgba(100,180,200,0.3);
}
.atamas-top-bar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 13px; padding: 0 9px;
}
.atamas-top-bar__title {
  font-family: 'Bahnschrift Condensed', 'Cascadia Code', sans-serif; font-weight: 700;
  font-size: 2rem; letter-spacing: 2.7px; color: #d6e6ff; margin: 0; transition: color 0.3s ease;
}
.game-atamas-page.light-mode .atamas-top-bar__title { color: #1e3a5f; }
.atamas-top-bar__actions { display: flex; gap: 8px; }
.atamas-top-bar-btn {
  background: transparent; border: 2px solid #3c6080; padding: 8px 16px; border-radius: 30px;
  font-weight: 600; color: #cddef5; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease;
  font-family: 'Bahnschrift SemiBold', 'Cascadia Code', sans-serif;
}
.game-atamas-page.light-mode .atamas-top-bar-btn { border-color: #8cc5d9; color: #2a4a6a; }
.atamas-top-bar-btn:hover { background: rgba(60,96,128,0.3); }
.game-atamas-page.light-mode .atamas-top-bar-btn:hover { background: rgba(140,197,217,0.3); }
.atamas-canvas-wrapper {
  display: flex; justify-content: center; align-items: center; gap: 15px;
  background: #122433; border-radius: 54px; padding: 18px;
  box-shadow: inset 0 5px 11px rgba(0,0,0,0.5); position: relative; transition: background 0.3s ease;
}
.game-atamas-page.light-mode .atamas-canvas-wrapper {
  background: #f0f8fc; box-shadow: inset 0 6px 12px rgba(100,180,200,0.15);
}
.atamas-canvas {
  display: block; width: 100%; height: auto; aspect-ratio: 1 / 1; background: #1c3148;
  border-radius: 50%; box-shadow: 0 0 0 4px #2f4b66, 0 12px 28px rgba(0,0,0,0.7);
  touch-action: none; cursor: pointer; max-width: 500px;
  transition: background 0.3s ease, box-shadow 0.3s ease;
}
.game-atamas-page.light-mode .atamas-canvas {
  background: #d0e8f0; box-shadow: 0 0 0 4px #a8d4e3, 0 12px 28px rgba(100,180,200,0.3);
}
.atamas-pending-preview-wrapper {
  display: flex; align-items: center; position: absolute; right: 0; top: 50%; transform: translateY(-50%);
}
.atamas-preview-toggle-btn {
  background: rgba(18,36,51,0.6); border: 1px solid rgba(138,180,214,0.3);
  border-radius: 6px 0 0 6px; width: 24px; height: 48px; display: flex;
  align-items: center; justify-content: center; cursor: pointer; transition: 0.2s ease;
  font-size: 1rem; font-weight: bold; color: #8ab4d6; z-index: 10;
}
.game-atamas-page.light-mode .atamas-preview-toggle-btn {
  background: rgba(200,220,230,0.5); border-color: rgba(106,154,176,0.5); color: #6a9ab0;
}
.atamas-preview-toggle-btn:hover { background: rgba(18,36,51,0.8); border-color: #8ab4d6; }
.game-atamas-page.light-mode .atamas-preview-toggle-btn:hover { background: rgba(200,220,230,0.7); border-color: #6a9ab0; }
.atamas-preview-toggle-btn:active { transform: scale(0.98); }
.atamas-pending-preview {
  display: flex; flex-direction: column; gap: 14px; padding: 14px;
  background: rgba(18,36,51,0.8); border-radius: 20px 0 0 20px; min-width: 70px; position: relative;
}
.atamas-pending-preview.hidden { display: none; }
.game-atamas-page.light-mode .atamas-pending-preview { background: rgba(200,220,230,0.5); }
.atamas-pending-preview__label {
  font-size: 0.7rem; color: #8ab4d6; text-align: center; text-transform: uppercase; letter-spacing: 0.5px;
}
.game-atamas-page.light-mode .atamas-pending-preview__label { color: #6a9ab0; }
.atamas-pending-ball {
  width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-weight: 600; font-size: 0.9rem;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid rgba(255,255,255,0.2);
}
.atamas-pending-ball.empty { border: 2px dashed rgba(60,96,128,0.5); }
.atamas-pending-ball.plus { font-size: 1.2rem; border: 2px solid rgba(255,215,0,0.6); }
.atamas-info-panel {
  display: flex; justify-content: center; align-items: center; margin-top: 15px; gap: 12px; flex-wrap: wrap;
}
.atamas-btn {
  background: #2a4a6a; border: none; padding: 12px 28px; border-radius: 60px; font-weight: 600;
  color: white; font-size: 1rem; box-shadow: 0 4px 0 #0e1c2b; transition: 0.08s linear; cursor: pointer;
  flex: 1 1 auto; min-width: 100px; letter-spacing: 0.5px;
  font-family: 'Bahnschrift SemiBold', 'Cascadia Code', sans-serif;
}
.game-atamas-page.light-mode .atamas-btn { background: #4a90b0; box-shadow: 0 4px 0 #2a6080; color: #ffffff; }
.atamas-btn:active { transform: translateY(4px); box-shadow: none; }
.atamas-btn--secondary { background: #4f5f7a; box-shadow: 0 4px 0 #2f3b4f; }
.game-atamas-page.light-mode .atamas-btn--secondary { background: #9ab8c8; box-shadow: 0 4px 0 #7a98a8; color: #1e3a5f; }
.atamas-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.atamas-turn-info {
  background: #1b2f42; padding: 10px 22px; border-radius: 40px; color: #cddef5; font-weight: 500;
  font-size: 0.95rem; font-family: 'Bahnschrift SemiLight', 'Cascadia Code', sans-serif;
}
.game-atamas-page.light-mode .atamas-turn-info { background: #e0f0f8; color: #2a4a6a; }
.atamas-turn-info strong {
  color: #ffd966; font-size: 1.2rem; font-family: 'Bahnschrift Bold', 'Cascadia Code', sans-serif;
}
.game-atamas-page.light-mode .atamas-turn-info strong { color: #e8a000; }
.atamas-message {
  text-align: center; margin-top: 14px; font-weight: 500; color: #f2c94c; min-height: 28px;
  font-size: 0.95rem; font-family: 'Bahnschrift SemiLight', 'Cascadia Code', sans-serif; transition: color 0.3s ease;
}
.game-atamas-page.light-mode .atamas-message { color: #c8a000; }
.atamas-message .example { color: #8ab4d6; font-size: 0.85rem; }
.game-atamas-page.light-mode .atamas-message .example { color: #6a9ab0; }
.atamas-bottom-bar {
  display: flex; justify-content: space-between; align-items: center; margin-top: 20px;
  padding: 15px 25px; background: #122433; border-radius: 40px; transition: background 0.3s ease;
}
.game-atamas-page.light-mode .atamas-bottom-bar { background: #f0f8fc; border: 2px solid #d0e8f0; }
.atamas-bottom-bar__item { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
.atamas-bottom-bar__label {
  font-family: 'Bahnschrift Light', 'Cascadia Code', sans-serif; font-size: 0.75rem; color: #8ab4d6;
  letter-spacing: 1px; text-transform: uppercase; transition: color 0.3s ease;
}
.game-atamas-page.light-mode .atamas-bottom-bar__label { color: #6a9ab0; }
.atamas-bottom-bar__value {
  font-family: 'Bahnschrift SemiBold', 'Cascadia Code', sans-serif; font-size: 1.5rem; font-weight: 600;
  color: #ffd966; transition: color 0.3s ease;
}
.game-atamas-page.light-mode .atamas-bottom-bar__value { color: #e8a000; }
.atamas-bottom-bar__value.max-number { color: #f87171; }
.game-atamas-page.light-mode .atamas-bottom-bar__value.max-number { color: #d9534f; }
.atamas-warning-lights { display: flex; gap: 8px; }
.atamas-warning-dot {
  width: 12px; height: 12px; border-radius: 50%; background: rgba(60,96,128,0.5); transition: all 0.3s ease;
}
.atamas-warning-dot.green { background: #10b981; box-shadow: 0 0 10px #10b981; }
.atamas-warning-dot.yellow { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; }
.atamas-warning-dot.red { background: #ef4444; box-shadow: 0 0 10px #ef4444; animation: atamas-pulse 1s infinite; }
@keyframes atamas-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: 0.8; }
}
.atamas-language-select { position: relative; display: inline-block; }
.atamas-language-btn {
  background: transparent; border: 2px solid #3c6080; padding: 8px 12px; border-radius: 30px;
  font-weight: 600; color: #cddef5; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease;
  display: flex; align-items: center; gap: 6px; min-width: 80px; justify-content: center;
  font-family: 'Bahnschrift SemiBold', 'Cascadia Code', sans-serif;
}
.game-atamas-page.light-mode .atamas-language-btn { border-color: #8cc5d9; color: #2a4a6a; }
.atamas-language-btn:hover { background: rgba(60,96,128,0.3); }
.game-atamas-page.light-mode .atamas-language-btn:hover { background: rgba(140,197,217,0.3); }
.atamas-language-btn .arrow { font-size: 0.7rem; transition: transform 0.2s ease; }
.atamas-language-select.open .atamas-language-btn .arrow { transform: rotate(180deg); }
.atamas-language-dropdown {
  position: absolute; top: calc(100% + 6px); right: 0; background: #1e2f44; border-radius: 12px;
  padding: 6px; min-width: 160px; max-height: 400px; overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none; z-index: 100; border: 2px solid #3c6080;
}
.game-atamas-page.light-mode .atamas-language-dropdown {
  background: #ffffff; border-color: #8cc5d9; box-shadow: 0 10px 30px rgba(100,180,200,0.3);
}
.atamas-language-select.open .atamas-language-dropdown { display: block; }
.atamas-language-option {
  padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s ease;
  font-size: 0.9rem; color: #cddef5; white-space: nowrap;
}
.game-atamas-page.light-mode .atamas-language-option { color: #2a4a6a; }
.atamas-language-option:hover { background: rgba(60,96,128,0.4); }
.game-atamas-page.light-mode .atamas-language-option:hover { background: rgba(140,197,217,0.3); }
.atamas-language-option.active { background: rgba(96,165,250,0.3); font-weight: 600; }
.game-atamas-page.light-mode .atamas-language-option.active { background: rgba(74,144,176,0.3); }
.atamas-attribution {
  text-align: center; margin-top: 15px; font-size: 0.8rem; color: #6a9ab0; font-style: italic;
}
.game-atamas-page.light-mode .atamas-attribution { color: #8ab4d6; }
@media (max-width: 550px) {
  .atamas-container { padding: 16px; }
  .atamas-btn { padding: 10px 16px; font-size: 0.9rem; }
  .atamas-top-bar__title { font-size: 1.6rem; }
  .atamas-bottom-bar__value { font-size: 1.2rem; }
  .atamas-top-bar__actions { gap: 4px; }
  .atamas-top-bar-btn, .atamas-language-btn { padding: 6px 10px; font-size: 0.75rem; }
  .atamas-language-dropdown { min-width: 140px; }
}
`;
