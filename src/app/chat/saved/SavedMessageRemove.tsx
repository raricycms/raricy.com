'use client';

// 保存箱条目的「取消保存」按钮。
//
// 服务端页面是 server component，取消之后用 router.refresh() 让它重新取数
// （列表 / 计数 / 分页游标都由服务端算，不在这里另维护一份客户端状态）。
// 接口是幂等的：重复点 / 慢网络都不会报错。

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function toast(message: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(message, type);
}

export default function SavedMessageRemove({ messageId }: { messageId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/chat/saved/${messageId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
      if (data.code === 200) {
        toast('已取消保存', 'success');
        router.refresh();
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="saved-msg__remove"
      disabled={busy}
      onClick={() => void remove()}
      title="取消保存（消息本身不会被删除）"
    >
      {busy ? '处理中…' : '取消保存'}
    </button>
  );
}
