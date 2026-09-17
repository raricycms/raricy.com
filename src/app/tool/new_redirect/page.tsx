'use client';

// 逐字对齐原 Flask 模板 tool/new_redirect.html（纯前端）。
import { useState } from 'react';

type Shortcut = { name: string; url: string; color: string };

const SHORTCUTS: Shortcut[] = [
  { name: '腾讯元宝', url: 'https://yuanbao.tencent.com', color: '#0081ff' },
  { name: 'QQ音乐', url: 'https://y.qq.com', color: '#31c27c' },
  { name: '聪明山', url: 'http://116.62.179.232:5002', color: '#9b59b6' },
  { name: '智慧河', url: 'http://116.62.179.232:22821', color: '#e74c3c' },
  { name: 'HUSTOJ', url: 'http://111.231.16.190', color: '#f39c12' },
];

export default function NewRedirectToolPage() {
  const [url, setUrl] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  // 跳转（对齐原 navigateToUrl：补协议 + 新标签打开）
  function navigate() {
    let v = url.trim();
    if (!v) {
      alert('请输入有效的网址');
      return;
    }
    if (!v.startsWith('http://') && !v.startsWith('https://')) {
      v = 'https://' + v;
      setUrl(v);
    }
    window.open(v, '_blank');
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') navigate();
  }

  function fill(s: Shortcut) {
    setUrl(s.url);
    setFlash(s.url);
    setTimeout(() => setFlash(null), 300);
  }

  return (
    <>

      <div style={{ padding: '20px 16px', display: 'flex', justifyContent: 'center' }}>
        <div className="nrd-container">
          <div style={{ marginBottom: 40 }}>
            <div className="nrd-tagline">跳转工具</div>
            <h1 className="nrd-h1">raricy.com</h1>
            <div className="nrd-subtitle">快速访问您常用的网站，减少干扰，提升效率</div>
          </div>

          <div className="nrd-section">
            <label className="nrd-label" htmlFor="url-input">输入链接地址：</label>
            <div className="nrd-input-group">
              <input
                type="url"
                id="url-input"
                className="nrd-input"
                placeholder="例如：https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="button" className="nrd-btn" onClick={navigate}>跳转</button>
            </div>
          </div>

          <div className="nrd-section">
            <div className="nrd-scut-title">快捷方式：</div>
            <div className="nrd-scut-buttons">
              {SHORTCUTS.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className="nrd-scut-btn"
                  style={{ borderColor: s.color + '40', backgroundColor: flash === s.url ? s.color + '15' : undefined }}
                  onClick={() => fill(s)}
                >
                  <div className="nrd-scut-name">{s.name}</div>
                  <div className="nrd-scut-url">{s.url}</div>
                  <div style={{ marginTop: 8, fontSize: '.85rem', color: '#3498db' }}>
                    点击填充 |{' '}
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#e74c3c', textDecoration: 'none' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      直接打开
                    </a>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="nrd-instructions">
            <h3>使用说明：</h3>
            <ul>
              <li>在输入框中输入完整的网址（包含 https:// 或 http://）</li>
              <li>点击&quot;跳转&quot;按钮，将在新标签页中打开链接</li>
              <li>点击下方任意快捷方式按钮，将自动填充对应链接到输入框</li>
              <li>您也可以直接点击快捷方式按钮旁边的&quot;打开&quot;链接直接访问</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
