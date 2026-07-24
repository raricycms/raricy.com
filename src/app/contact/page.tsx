import type { Metadata } from 'next';
import FooterNote from '@/app/components/FooterNote';

export const metadata: Metadata = { title: 'Raricy.com - 联系我们' };

// 联系页 — Flask BEM
// 对齐 app/templates/home/contact.html：用 content-wrapper 包裹 + page-title 标题。
export default function ContactPage() {
  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-chat-dots_new" aria-hidden="true"></span> 联系我们
      </h1>
      <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)', marginBottom: '1.5rem' }}>
        遇到问题或有建议？我们随时为您服务。
      </p>

      <ul style={{ listStyle: 'none', padding: 0, maxWidth: 560, margin: '0 auto' }}>
        <li style={{ marginBottom: '1rem' }}>
          <span className="icon icon-envelope" aria-hidden="true"></span>
          <span style={{ marginRight: '0.5rem' }}>电子邮件：</span>
          <a href="mailto:raricycms@gmail.com" style={{ color: 'var(--color-brand-primary)' }}>
            raricycms@gmail.com
          </a>
        </li>
        <li style={{ marginBottom: '1rem' }}>
          <span className="icon icon-people" aria-hidden="true"></span>
          <span style={{ marginRight: '0.5rem' }}>微信号：</span>
          <span>whitealiveautumn0</span>
        </li>
        <li style={{ marginBottom: '1rem' }}>
          <span style={{ marginRight: '0.5rem' }}>或通过 GitHub 提交问题：</span>
          <a
            href="https://github.com/raricycms/raricy.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--color-brand-primary)' }}
          >
            <span className="icon icon-github" aria-hidden="true"></span> 项目仓库
          </a>
        </li>
      </ul>

      <FooterNote>
        <p style={{ color: 'var(--color-text-tertiary)', textAlign: 'center' }}>就在附近！</p>
      </FooterNote>
    </div>
  );
}