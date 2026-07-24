'use client';

// Cattca 脚本编辑器 —— 对齐 Flask app/templates/tool/cattca.html 的双面板结构
// （编辑器面板 + 游戏运行面板）。编辑器面板承载：语法指南链接、状态、文本框、
// 运行/撤回/重做/保存/加载/示例按钮、撤销历史、localStorage 自动保存/恢复、
// 键盘快捷键。游戏运行区（含全屏）由 CattcaPlayer（tool 变体）承载。
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import CattcaPlayer, { CattcaPlayerHandle } from '@/app/components/CattcaPlayer';

const EXAMPLE_SCRIPT = [
  '# 莱莉菥的早晨',
  '',
  '你叫**莱莉菥**。',
  '现在是早上六点，你醒了。',
  '你躺在床上。',
  '',
  '## 你要怎么做？',
  '',
  '</let cntsleep = 0;',
  'label 1;',
  'input case:',
  "'继续睡觉' -> goto 2:",
  "'起床' -> goto 3;",
  '/>',
  '',
  '</label 2;',
  'set cntsleep = cntsleep + 1;',
  'if cntsleep > 3 ->goto 4/>',
  '你睡不着。已经尝试了 </apply cntsleep /> 次。',
  '',
  '### 状态',
  '- 尝试睡觉次数：</apply cntsleep />',
  '- 当前时间：早上</apply cntsleep+5/>点',
  '',
  '</goto 1;/>',
  '',
  '</label 3/>',
  '# 结局一：起床',
  '',
  '你成功起床了！',
  '',
  '> 新的一天开始了，充满无限可能。',
  '',
  '</exit/>',
  '',
  '</label 4/>',
  '# 结局二：睡觉',
  '',
  '你又睡着了。',
  '',
  '> 有时候，休息是最好的选择。',
  '',
  '</exit/>',
].join('\n');

type StatusType = 'ready' | 'running' | 'error';

const STORAGE_KEY = 'cattca_script';
const STORAGE_TS_KEY = 'cattca_script_timestamp';
const HISTORY_MAX = 100;

export default function CattcaToolPage() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('准备就绪');
  const [statusType, setStatusType] = useState<StatusType>('ready');
  const [undoDisabled, setUndoDisabled] = useState(true);
  const [redoDisabled, setRedoDisabled] = useState(true);

  // 运行触发：递增 runId 让 CattcaPlayer 重跑；runScriptText 为交给引擎的脚本。
  const [runId, setRunId] = useState(0);
  const [runScriptText, setRunScriptText] = useState('');

  const playerRef = useRef<CattcaPlayerHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // textRef 始终指向最新 text，供延时/回调读取（避免闭包捕获旧值）。
  const textRef = useRef('');

  // 撤销/重做历史（用 ref 承载，避免每次输入触发重渲染）。
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const isUndoRedoRef = useRef(false);

  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStatus = useCallback((textValue: string, type: StatusType = 'ready') => {
    setStatus(textValue);
    setStatusType(type);
  }, []);

  const updateUndoRedoButtons = useCallback(() => {
    setUndoDisabled(historyIndexRef.current <= 0);
    setRedoDisabled(historyIndexRef.current >= historyRef.current.length - 1);
  }, []);

  const addToHistory = useCallback(
    (content: string) => {
      if (isUndoRedoRef.current) return;
      const history = historyRef.current;
      if (historyIndexRef.current < history.length - 1) {
        historyRef.current = history.slice(0, historyIndexRef.current + 1);
      }
      const h = historyRef.current;
      if (h.length === 0 || h[h.length - 1] !== content) {
        h.push(content);
        historyIndexRef.current = h.length - 1;
        if (h.length > HISTORY_MAX) {
          h.shift();
          historyIndexRef.current--;
        }
      }
      updateUndoRedoButtons();
    },
    [updateUndoRedoButtons],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      isUndoRedoRef.current = true;
      setText(historyRef.current[historyIndexRef.current]);
      isUndoRedoRef.current = false;
      updateUndoRedoButtons();
      updateStatus('已撤回', 'ready');
    }
  }, [updateUndoRedoButtons, updateStatus]);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      isUndoRedoRef.current = true;
      setText(historyRef.current[historyIndexRef.current]);
      isUndoRedoRef.current = false;
      updateUndoRedoButtons();
      updateStatus('已重做', 'ready');
    }
  }, [updateUndoRedoButtons, updateStatus]);

  const showAutoSaveIndicator = useCallback(() => {
    const prevText = status;
    const prevType = statusType;
    setStatus('自动保存中...');
    setStatusType('running');
    if (indicatorTimeoutRef.current) clearTimeout(indicatorTimeoutRef.current);
    indicatorTimeoutRef.current = setTimeout(() => {
      setStatus(prevText);
      setStatusType(prevType);
    }, 800);
  }, [status, statusType]);

  const saveToLocalStorage = useCallback(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, textRef.current);
    localStorage.setItem(STORAGE_TS_KEY, new Date().toISOString());
    showAutoSaveIndicator();
  }, [showAutoSaveIndicator]);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const runScript = useCallback(() => {
    const script = textRef.current.trim();
    if (!script) {
      updateStatus('请输入脚本内容', 'error');
      return;
    }
    updateStatus('运行中...', 'running');
    setRunScriptText(script);
    setRunId((n) => n + 1);
  }, [updateStatus]);

  const saveScript = useCallback(() => {
    const script = textRef.current.trim();
    if (!script) {
      updateStatus('没有内容可保存', 'error');
      return;
    }
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'script.cattca';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    updateStatus('脚本已保存', 'ready');
    saveToLocalStorage();
  }, [updateStatus, saveToLocalStorage]);

  const loadScript = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cattca';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const loaded = String(ev.target?.result ?? '');
          setText(loaded);
          addToHistory(loaded);
          updateStatus('脚本已加载', 'ready');
          saveToLocalStorage();
        };
        reader.readAsText(file);
      }
    };
    input.click();
  }, [addToHistory, updateStatus, saveToLocalStorage]);

  const loadExample = useCallback(() => {
    setText(EXAMPLE_SCRIPT);
    addToHistory(EXAMPLE_SCRIPT);
    updateStatus('示例已加载', 'ready');
  }, [addToHistory, updateStatus]);

  // 初始化：从 localStorage 恢复，否则加载示例。
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setText(saved);
      addToHistory(saved);
      const timestamp = localStorage.getItem(STORAGE_TS_KEY);
      if (timestamp) {
        const saveTime = new Date(timestamp).toLocaleString();
        updateStatus('已从浏览器缓存恢复 (' + saveTime + ')', 'ready');
      }
    } else {
      setText(EXAMPLE_SCRIPT);
      addToHistory(EXAMPLE_SCRIPT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 输入时的防抖：500ms 入历史、1000ms 自动保存。
  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);
      if (isUndoRedoRef.current) return;
      if (historyTimeoutRef.current) clearTimeout(historyTimeoutRef.current);
      historyTimeoutRef.current = setTimeout(() => addToHistory(value), 500);
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = setTimeout(() => saveToLocalStorage(), 1000);
    },
    [addToHistory, saveToLocalStorage],
  );

  // 编辑器键盘快捷键：Ctrl+Enter 运行 / Ctrl+S 保存 / Ctrl+Z 撤回 /
  // Ctrl+Y|Ctrl+Shift+Z 重做 / Ctrl+F 全屏。
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        runScript();
      }
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveScript();
      }
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        playerRef.current?.toggleFullscreen();
      }
    },
    [runScript, saveScript, undo, redo],
  );

  return (
    <div className="story-cattca cattca-tool">
      <div className="container">
        <Link href="/tool" className="story-cattca__back">
          ← 返回工具箱
        </Link>

        <div className="cattca-tool__grid">
          {/* 脚本编辑器面板 */}
          <div className="cattca-tool__panel cattca-tool__panel--editor">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <h2
                className="story-cattca__panel-title"
                style={{ borderBottom: 'none', paddingBottom: 0, marginBottom: 0 }}
              >
                Cattca 脚本编辑器
              </h2>
              <Link
                href="/tool/cattca-guide"
                target="_blank"
                rel="noopener"
                style={{
                  fontSize: '0.8125rem',
                  color: 'var(--color-brand-primary)',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  padding: '0.25rem 0.5rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '0.25rem',
                  transition: 'all 0.2s ease',
                }}
              >
                语法指南
              </Link>
            </div>
            <div className={`cattca-tool__status cattca-tool__status--${statusType}`}>{status}</div>
            <textarea
              ref={textareaRef}
              className="cattca-tool__script-input"
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="在这里输入你的 Cattca 脚本..."
            />
            <div className="cattca-tool__button-group">
              <button className="cattca-tool__btn cattca-tool__btn--primary" onClick={runScript}>
                ▶运行脚本
              </button>
              <button
                className="cattca-tool__btn cattca-tool__btn--secondary"
                onClick={undo}
                disabled={undoDisabled}
              >
                ↶ 撤回
              </button>
              <button
                className="cattca-tool__btn cattca-tool__btn--secondary"
                onClick={redo}
                disabled={redoDisabled}
              >
                ↷ 重做
              </button>
              <button className="cattca-tool__btn cattca-tool__btn--secondary" onClick={saveScript}>
                保存脚本
              </button>
              <button className="cattca-tool__btn cattca-tool__btn--secondary" onClick={loadScript}>
                加载脚本
              </button>
              <button className="cattca-tool__btn cattca-tool__btn--secondary" onClick={loadExample}>
                加载示例
              </button>
            </div>
          </div>

          {/* 游戏运行面板（含标题栏、全屏按钮与全屏覆盖层，由 CattcaPlayer 承载） */}
          <div className="cattca-tool__panel cattca-tool__panel--game">
            <CattcaPlayer
              ref={playerRef}
              variant="tool"
              script={runScriptText}
              runId={runId}
              onStatus={updateStatus}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
