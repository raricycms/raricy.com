import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'raricy.com - 获取注册资格' };

// 获取注册资格页 — 布局约定
// 本页不含任何操作控件：只保留一个简短的「邀请码流程」说明 + footer note。
export default function ValidUserPage() {
  return (
    <div className="content-wrapper">
      <h1 className="page-title">获取注册资格</h1>
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
    </div>
  );
}