'use client';

// 逐字对齐原 Flask 模板 tool/redirect.html（纯前端）。
import { useEffect, useRef, useState } from 'react';

type Shortcut = { url: string; title: string; label: string };

const SHORTCUTS: Shortcut[] = [
  { url: 'http://111.231.16.190', title: 'hustOJ', label: 'hustOJ' },
  { url: 'https://yuanbao.tencent.com/', title: 'yuanbao', label: '腾讯元宝' },
  { url: 'http://116.62.179.232', title: 'raricy', label: '本站' },
];

export default function RedirectToolPage() {
  const [targetUrl, setTargetUrl] = useState('');
  const [delayTime, setDelayTime] = useState('3');
  const [preview, setPreview] = useState<string | null>(null);
  const [countingDown, setCountingDown] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 实时预览 URL（对齐原 input 事件）
  function onUrlInput(v: string) {
    setTargetUrl(v);
    const url = v.trim();
    if (url) {
      try {
        new URL(url);
        setPreview(url);
      } catch {
        setPreview(null);
      }
    } else {
      setPreview(null);
    }
  }

  // 自动补协议（对齐原 blur 事件）
  function onUrlBlur() {
    const url = targetUrl.trim();
    if (url && !url.match(/^https?:\/\//)) {
      setTargetUrl('https://' + url);
    }
  }

  function startCountdown(url: string, delay: number) {
    setCountingDown(true);
    setPreview(null);
    let timeLeft = delay;
    setCountdown(timeLeft);
    timerRef.current = setInterval(() => {
      timeLeft -= 1;
      setCountdown(timeLeft);
      if (timeLeft <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        window.location.href = url;
      }
    }, 1000);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const url = targetUrl.trim();
    const delay = parseInt(delayTime, 10) || 3;
    if (!url) {
      alert('请输入目标网址');
      return;
    }
    try {
      new URL(url);
    } catch {
      alert('请输入有效的网址格式');
      return;
    }
    startCountdown(url, delay);
  }

  function onCancel() {
    if (timerRef.current) clearInterval(timerRef.current);
    setCountingDown(false);
    setPreview(null);
  }

  function onShortcut(s: Shortcut) {
    setTargetUrl(s.url);
    setPreview(s.url);
    const delay = parseInt(delayTime, 10) || 3;
    startCountdown(s.url, delay);
  }

  return (
    <>
      <style>{`
        .rdr-hero{background:radial-gradient(1200px 400px at 10% -10%,rgba(13,110,253,.25),transparent 60%),radial-gradient(900px 300px at 90% -20%,rgba(111,66,193,.25),transparent 60%),linear-gradient(180deg,#0d6efd10,transparent);border-bottom:1px solid rgba(255,255,255,.08);padding:3rem 0}
        .rdr-wrap{width:100%;max-width:960px;margin:0 auto;padding:0 1rem}
        .rdr-card{background:var(--surface,rgba(255,255,255,.85));backdrop-filter:blur(6px);border:1px solid var(--line,rgba(0,0,0,.06));border-radius:14px;transition:transform .2s ease,box-shadow .2s ease;max-width:720px;margin:0 auto}
        .rdr-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.08)}
        .rdr-card__body{padding:1.75rem}
        .rdr-title{font-size:2rem;font-weight:700;margin-bottom:.75rem}
        .rdr-muted{color:var(--ink-2,#6c757d)}
        .rdr-label{font-weight:600;display:block;margin-bottom:.5rem}
        .rdr-input{width:100%;padding:.6rem .8rem;border:1px solid var(--line,#dee2e6);border-radius:.4rem;background:var(--surface-2,#fff);color:inherit;font-family:'Monaco','Menlo','Ubuntu Mono',monospace}
        .rdr-field{margin-bottom:1.25rem}
        .rdr-help{font-size:.85rem;color:var(--ink-2,#6c757d);margin-top:.35rem}
        .rdr-btn{background:linear-gradient(135deg,#0d6efd,#3b8bfd);border:none;color:#fff;padding:.8rem 1rem;border-radius:.5rem;font-size:1.05rem;font-weight:600;width:100%;cursor:pointer;transition:all .3s ease}
        .rdr-btn:hover{background:linear-gradient(135deg,#0b5ed7,#2c7ce6);transform:translateY(-1px)}
        .rdr-scut{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.5rem}
        .rdr-scut__btn{padding:.5rem;border:1px solid rgba(0,0,0,.125);border-radius:.4rem;background:transparent;color:var(--accent,#f0ad4e);font-weight:500;cursor:pointer;transition:all .2s ease}
        .rdr-scut__btn:hover{transform:translateY(-1px);box-shadow:0 4px 8px rgba(0,0,0,.1)}
        .rdr-preview{background:var(--surface-2,#f8f9fa);border:1px solid var(--line,#dee2e6);border-radius:.375rem;padding:.75rem;font-family:'Monaco','Menlo','Ubuntu Mono',monospace;font-size:.875rem;word-break:break-all}
        .rdr-count{font-size:1.25rem;font-weight:600;color:#dc3545}
        .rdr-warn{background:linear-gradient(135deg,#fff3cd,#ffeaa7);border:1px solid #ffeaa7;border-radius:.5rem;padding:1rem;color:#5c4a00;margin-top:1rem}
        .rdr-warn ul{margin:0;padding-left:1.2rem;font-size:.85rem}
        .rdr-hr{border:0;border-top:1px solid var(--line,rgba(0,0,0,.1));margin:1.25rem 0}
      `}</style>

      <section className="rdr-hero">
        <div className="rdr-wrap">
          <h1 className="rdr-title">网址重定向工具</h1>
          <p className="rdr-muted">安全地跳转到目标网址，支持自定义延迟时间，让您有足够时间确认目标地址。</p>
        </div>
      </section>

      <section style={{ padding: '2.5rem 0' }}>
        <div className="rdr-wrap">
          <div className="rdr-card">
            <div className="rdr-card__body">
              <h3 style={{ marginTop: 0, marginBottom: '1.25rem' }}>
                <span className="icon icon-link" style={{ marginRight: 6 }} />网址重定向
              </h3>

              <div className="rdr-field">
                <h5 style={{ marginBottom: '.75rem' }}>快捷访问</h5>
                <div className="rdr-scut">
                  {SHORTCUTS.map((s) => (
                    <button key={s.title} type="button" className="rdr-scut__btn" onClick={() => onShortcut(s)}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <hr className="rdr-hr" />
              </div>

              {!countingDown && (
                <form onSubmit={onSubmit}>
                  <div className="rdr-field">
                    <label className="rdr-label" htmlFor="targetUrl">目标网址</label>
                    <input
                      type="url"
                      className="rdr-input"
                      id="targetUrl"
                      placeholder="https://example.com"
                      value={targetUrl}
                      onChange={(e) => onUrlInput(e.target.value)}
                      onBlur={onUrlBlur}
                      required
                    />
                    <div className="rdr-help">请输入完整的网址，包含协议（http:// 或 https://）</div>
                  </div>

                  <div className="rdr-field">
                    <label className="rdr-label" htmlFor="delayTime">延迟时间（秒）</label>
                    <input
                      type="number"
                      className="rdr-input"
                      id="delayTime"
                      value={delayTime}
                      min={0}
                      max={30}
                      onChange={(e) => setDelayTime(e.target.value)}
                      required
                    />
                    <div className="rdr-help">设置跳转前的等待时间，让您有时间确认目标地址</div>
                  </div>

                  <div className="rdr-field">
                    <button type="submit" className="rdr-btn">开始重定向</button>
                  </div>
                </form>
              )}

              {!countingDown && preview && (
                <div className="rdr-field">
                  <h5 style={{ marginBottom: '.5rem' }}>即将跳转到：</h5>
                  <div className="rdr-preview">{preview}</div>
                </div>
              )}

              {countingDown && (
                <div style={{ textAlign: 'center' }}>
                  <div className="rdr-count" style={{ marginBottom: '.75rem' }}>{countdown}</div>
                  <p className="rdr-muted">正在跳转，请稍候...</p>
                  <button type="button" className="rdr-scut__btn" onClick={onCancel}>取消跳转</button>
                </div>
              )}

              <div className="rdr-warn">
                <h6 style={{ margin: '0 0 .5rem' }}>安全提醒</h6>
                <ul>
                  <li>请确认目标网址的安全性，避免访问可疑或恶意网站</li>
                  <li>本工具仅提供跳转功能，不承担任何安全责任</li>
                  <li>建议在跳转前检查网址是否正确</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
