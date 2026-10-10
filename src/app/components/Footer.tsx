import Link from 'next/link';
import type { ReactNode } from 'react';

// 页脚 — site-footer / site-footer-container / site-footer-row / social-links 布局
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
              <span style={{ margin: '0 0.5rem', color: 'var(--color-text-tertiary)' }}>|</span>
              {/* 管理公示属于站务信息，入口对所有人保留；/audit 自己校验 core+。 */}
              <Link href="/audit" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                管理公示
              </Link>
              <span style={{ margin: '0 0.5rem', color: 'var(--color-text-tertiary)' }}>|</span>
              {/* 文档索引 /docs —— 站内所有文档（使用指南 / 机器人接口 / 开发运维）
                  的唯一入口。挂在页脚而不是顶栏：顶栏保留站内四个内容区，
                  文档是给站外读者的（机器人开发者、自部署的人）。 */}
              <Link href="/docs" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                文档
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
