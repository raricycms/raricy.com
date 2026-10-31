import type { Metadata } from 'next';
import { GitBranch, Mail, MessageCircle } from 'lucide-react';
import PageHeader from '@/app/components/PageHeader';

export const metadata: Metadata = { title: 'Raricy.com - 联系我们' };

// 联系页：三条真实联系方式，一行一条；卡片与按钮沿用站内既有语言。
export default function ContactPage() {
  return (
    <div className="content-wrapper contact-page">
      <PageHeader title="联系我们" description="遇到问题或有建议时，可以通过以下方式联系。" />

      <section className="contact-card" aria-label="联系方式">
        <div className="contact-row">
          <span className="contact-row__icon" aria-hidden="true"><Mail /></span>
          <div className="contact-row__text">
            <span className="contact-row__label">电子邮件</span>
            <a className="contact-row__value" href="mailto:raricycms@gmail.com">raricycms@gmail.com</a>
          </div>
        </div>

        <div className="contact-row">
          <span className="contact-row__icon" aria-hidden="true"><MessageCircle /></span>
          <div className="contact-row__text">
            <span className="contact-row__label">微信号</span>
            <span className="contact-row__value contact-row__value--plain">whitealiveautumn0</span>
          </div>
        </div>

        <div className="contact-row">
          <span className="contact-row__icon" aria-hidden="true"><GitBranch /></span>
          <div className="contact-row__text">
            <span className="contact-row__label">问题反馈</span>
            <span className="contact-row__desc">也可以在项目仓库提交问题。</span>
          </div>
          <a
            className="contact-row__action"
            href="https://github.com/raricycms/raricy.com"
            target="_blank"
            rel="noreferrer"
          >
            打开仓库
          </a>
        </div>
      </section>
    </div>
  );
}
