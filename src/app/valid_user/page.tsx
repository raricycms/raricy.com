import type { Metadata } from 'next';
import FooterNote from '@/app/components/FooterNote';

export const metadata: Metadata = { title: 'raricy.com - 获取注册资格' };

// 获取注册资格页 — Flask BEM
// 模板本体的 content 块为空（详见 app/templates/home/valid_user.html），
// 这里只保留一个简短的「邀请码流程」说明 + footer note，与原站保持一致。
export default function ValidUserPage() {
  return (
    <div className="content-wrapper">
      <h1 className="page-title">获取注册资格</h1>
      <p style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>
        本页面无直接操作，仅作为「获取邀请码」流程的说明。
      </p>
      <div style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          邀请码流程
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
          当前注册开放邀请制。如果你已经获得邀请码，请在{' '}
          <a href="/register">注册页</a> 填入；
          如果还未获得，可前往 <a href="/contact">联系我们</a> 申请。
        </p>
      </div>
      <FooterNote>你来对地方了。</FooterNote>
    </div>
  );
}