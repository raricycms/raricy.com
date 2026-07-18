import Link from 'next/link';
import type { ReactNode } from 'react';

// 页脚：严格对齐原 base.html 的 .site-footer 结构与类名。
// children 对应原模板第一个 div 内的 {% block footer_text %} 槽——
// 仅首页注入"智慧河"提示，其余页面为空。
export default function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div>
          <div className="footer-brand">聪明山 Raricy.com</div>
          <div className="footer-links">
            <Link href="/terms">用户协议</Link>
            <span className="footer-sep">/</span>
            <Link href="/privacy">隐私政策</Link>
          </div>
          {children}
        </div>
        <div>
          <div className="social-links">
            <a href="https://github.com/raricycms/raricy.com" aria-label="GitHub">
              <span className="icon icon-github"></span>
            </a>
            <a href="/contact" aria-label="联系">
              <span className="icon icon-twitter"></span>
            </a>
            <a href="mailto:raricycms@gmail.com" aria-label="邮件">
              <span className="icon icon-envelope"></span>
            </a>
          </div>
          <p className="footer-copy">&copy; 2026 聪明山. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
