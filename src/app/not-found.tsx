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
