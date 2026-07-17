'use client';

// 提交申诉表单（对齐 Flask admin_action_log_detail.html 的 submitAppeal）。
// 拆成客户端组件：详情页本身是服务端组件，只有这一小块需要交互。

import { useRouter } from 'next/navigation';
import { useState } from 'react';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

const MAX_LEN = 2000; // 与 audit-service.APPEAL_MAX_LEN 一致

export default function AppealForm({ logId }: { logId: number }) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = content.trim();
    if (!text) {
      window.showToast?.('申诉内容不能为空', 'warning');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/audit/${logId}/appeal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (data.code === 200) {
        window.showToast?.(data.message || '申诉已提交', 'success');
        setContent('');
        router.refresh(); // 重新拉服务端数据，让新申诉出现在上面的列表里
      } else {
        window.showToast?.(data.message || '提交失败', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3">
      <h5 className="mb-2">提交申诉</h5>
      <textarea
        className="form-control mb-2"
        rows={3}
        maxLength={MAX_LEN}
        placeholder="请填写你的申诉理由…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={busy}
      />
      <div className="d-flex justify-content-between align-items-center">
        <small className="text-muted">
          {content.length} / {MAX_LEN}
        </small>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !content.trim()}>
          {busy ? '提交中…' : '提交'}
        </button>
      </div>
    </div>
  );
}
