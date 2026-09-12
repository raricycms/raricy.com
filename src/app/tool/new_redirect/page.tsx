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
      <style>{`
        .nrd-container{width:100%;max-width:800px;margin:0 auto;background:var(--surface,#fff);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);padding:40px;text-align:center;color:inherit}
        .nrd-tagline{color:#3498db;font-weight:500;font-size:1.2rem;margin-bottom:5px}
        .nrd-h1{color:var(--ink,#2c3e50);font-size:2.4rem;margin-bottom:8px;font-weight:700}
        .nrd-subtitle{color:var(--ink-2,#7f8c8d);font-size:1.1rem;margin-bottom:20px}
        .nrd-section{margin-bottom:40px;text-align:left}
        .nrd-label{display:block;margin-bottom:10px;color:var(--ink,#2c3e50);font-weight:600;font-size:1.1rem}
        .nrd-input-group{display:flex;gap:10px}
        .nrd-input{flex:1;padding:16px 20px;font-size:1.1rem;border:2px solid var(--line,#e1e8ed);border-radius:12px;outline:none;background:var(--surface-2,#fff);color:inherit;transition:all .3s ease}
        .nrd-input:focus{border-color:#3498db;box-shadow:0 0 0 3px rgba(52,152,219,.2)}
        .nrd-btn{padding:16px 32px;background:#3498db;color:#fff;border:none;border-radius:12px;font-size:1.1rem;font-weight:600;cursor:pointer;transition:all .3s ease}
        .nrd-btn:hover{background:#2980b9;transform:translateY(-2px);box-shadow:0 5px 15px rgba(52,152,219,.3)}
        .nrd-btn:active{transform:translateY(0)}
        .nrd-scut-title{color:var(--ink,#2c3e50);font-weight:600;font-size:1.1rem;margin-bottom:20px}
        .nrd-scut-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:15px}
        .nrd-scut-btn{padding:16px;background:var(--surface-2,#f8f9fa);color:var(--ink,#2c3e50);border:2px solid var(--line,#e1e8ed);border-radius:12px;font-size:1rem;font-weight:500;cursor:pointer;transition:all .3s ease;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center}
        .nrd-scut-btn:hover{background:#e8f4fc;border-color:#3498db;transform:translateY(-3px);box-shadow:0 5px 15px rgba(52,152,219,.1)}
        .nrd-scut-name{font-weight:600;margin-bottom:5px}
        .nrd-scut-url{font-size:.85rem;color:var(--ink-2,#7f8c8d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}
        .nrd-instructions{background:var(--surface-2,#f8f9fa);padding:20px;border-radius:12px;margin-top:30px;text-align:left}
        .nrd-instructions h3{color:var(--ink,#2c3e50);margin-bottom:10px;font-size:1.1rem}
        .nrd-instructions ul{padding-left:20px;color:var(--ink-2,#555)}
        .nrd-instructions li{margin-bottom:8px}
        @media (max-width:768px){.nrd-container{padding:25px}.nrd-h1{font-size:2rem}.nrd-input-group{flex-direction:column}.nrd-btn{width:100%}.nrd-scut-buttons{grid-template-columns:1fr}}
      `}</style>

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
