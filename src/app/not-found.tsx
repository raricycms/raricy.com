import type { Metadata } from 'next';
import Link from 'next/link';

// 404 页面未找到 —— 使用主题令牌，随 data-theme 自动适配深浅色（对齐站点卡片 / 品牌色风格）。
// 未匹配到任何路由时，由 Next.js 的 app/not-found 以 404 状态渲染。
export const metadata: Metadata = {
  title: '页面未找到 · 聪明山',
};

export default function NotFound() {
  return (
    <>
      <style>{`
        .nf{position:relative;min-height:calc(100vh - 62px);display:flex;align-items:center;justify-content:center;padding:48px 24px;background:var(--color-background-page);overflow:hidden}
        .nf__glow{position:absolute;top:50%;left:50%;width:440px;height:440px;transform:translate(-50%,-50%);background:radial-gradient(circle,var(--color-brand-secondary) 0%,transparent 70%);border-radius:50%;pointer-events:none}
        .nf__card{position:relative;max-width:480px;width:100%;padding:52px 44px;border-radius:20px;background:var(--color-background-card);border:1px solid var(--color-border);box-shadow:var(--shadow-card);text-align:center}
        .nf__code{font-size:clamp(5rem,18vw,7.5rem);font-weight:800;line-height:1;letter-spacing:-.04em;color:var(--color-brand-primary)}
        .nf__title{font-size:clamp(1.4rem,4vw,1.8rem);font-weight:700;margin-top:6px;color:var(--color-text-primary)}
        .nf__divider{width:48px;height:3px;border-radius:999px;margin:18px auto 0;background:linear-gradient(90deg,var(--color-brand-primary),transparent)}
        .nf__msg{margin-top:18px;font-size:1.02rem;line-height:1.7;color:var(--color-text-primary)}
        .nf__hint{margin-top:8px;font-size:.9rem;line-height:1.7;color:var(--color-text-secondary)}
        .nf__actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:30px}
        .nf__btn{display:inline-flex;align-items:center;gap:7px;padding:11px 24px;border-radius:999px;font-size:.95rem;font-weight:600;transition:transform .2s ease,box-shadow .2s ease,background-color .2s ease,color .2s ease,border-color .2s ease}
        .nf__btn .icon{width:1.05rem;height:1.05rem}
        .nf__btn--solid{background:var(--color-brand-primary);color:#fff}
        .nf__btn--solid:hover{transform:translateY(-2px);box-shadow:var(--shadow-card-brand)}
        .nf__btn--ghost{background:var(--color-background-subtle);color:var(--color-text-primary);border:1px solid var(--color-border)}
        .nf__btn--ghost:hover{transform:translateY(-2px);border-color:var(--color-brand-primary);color:var(--color-brand-primary)}
        @media (prefers-reduced-motion: reduce){.nf__btn:hover{transform:none}}
      `}</style>
      <div className="nf">
        <div className="nf__glow" aria-hidden="true"></div>
        <div className="nf__card">
          <p className="nf__code">404</p>
          <h1 className="nf__title">页面未找到</h1>
          <div className="nf__divider" aria-hidden="true"></div>
          <p className="nf__msg">抱歉，您访问的页面不存在，或已被移动、删除。</p>
          <p className="nf__hint">
            可能是链接已失效、网址拼写有误，或内容调整了位置。请检查地址后重试。
          </p>
          <div className="nf__actions">
            <Link href="/" className="nf__btn nf__btn--solid">
              <span className="icon icon-house"></span>返回首页
            </Link>
            <Link href="/blog" className="nf__btn nf__btn--ghost">
              <span className="icon icon-book"></span>浏览博客
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
