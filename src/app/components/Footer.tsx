import Link from 'next/link';
import type { ReactNode } from 'react';

// 页脚 — Flask `base.html` 样式（site-footer + site-footer-container/site-footer-row/social-links）
export default function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-container">
        <div className="site-footer-row">
          <div className="site-footer-left">
            <h5>聪明山 Raricy.com</h5>
            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem' }}>
              <Link href="/terms" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                用户协议
              </Link>
              <span style={{ margin: '0 0.5rem', color: 'var(--color-text-tertiary)' }}>|</span>
              <Link href="/privacy" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                隐私政策
              </Link>
            </div>
            {children && <div>{children}</div>}
          </div>
          <div className="site-footer-right">
            <div className="social-links">
              <a href="https://github.com/raricycms/raricy.com" aria-label="GitHub">
                <span className="icon icon-github" aria-hidden="true"></span>
              </a>
              <a href="/contact" aria-label="Twitter">
                <span className="icon icon-twitter" aria-hidden="true"></span>
              </a>
              <a href="mailto:raricycms@gmail.com" aria-label="Email">
                <span className="icon icon-envelope" aria-hidden="true"></span>
              </a>
            </div>
            <p style={{ marginTop: '0.5rem' }}>© 2026 聪明山. All rights reserved.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}