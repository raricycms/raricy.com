'use client';

import { useRouter } from 'next/navigation';

const ACTION_TYPES = ['ban_user', 'unban_user', 'delete_blog', 'delete_comment'];

// 操作类型筛选 — 对齐 Flask admin_action_logs.html
export default function ActionFilter({ action }: { action: string }) {
  const router = useRouter();
  return (
    <form method="get" className="mb-3 d-flex" style={{ gap: 8 }}>
      <select
        name="action"
        className="form-select"
        style={{ maxWidth: 260 }}
        defaultValue={action}
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/audit?action=${encodeURIComponent(v)}` : '/audit');
        }}
      >
        <option value="">全部类型</option>
        {ACTION_TYPES.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" className="btn btn-primary">
          筛选
        </button>
      </noscript>
    </form>
  );
}
