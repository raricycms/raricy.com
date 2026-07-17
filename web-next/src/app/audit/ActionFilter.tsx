'use client';

// 对齐 Flask app/templates/auth/admin_action_logs.html 的筛选下拉：
// Flask 用 <select onchange="this.form.submit()"> 实现选中即提交（重置到第 1 页，仅带 action）。
// 这里用 useRouter 在 onChange 时导航到 /audit?action=...，JS 关闭时退回 <noscript> 的提交按钮。
import { useRouter } from 'next/navigation';

const ACTION_TYPES = ['ban_user', 'unban_user', 'delete_blog', 'delete_comment'];

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
