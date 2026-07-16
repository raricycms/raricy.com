'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminBlogActions — 文章列表单行的操作簇（对齐 Flask manage_articles.html 行内动作）：
//   栏目下拉（category-select）+ 查看 + 设为精选/取消精选。
//   改栏目 / 切精选走 PATCH /api/admin/blogs/:id，成功后 router.refresh() 让服务端重渲染，
//   等价于 Flask 的就地更新 current-category / featured-flag。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export interface CategoryOpt {
  id: number;
  label: string; // 含图标前缀；子栏目形如「　└ 图标 名称」
}

// 对齐 Flask render_category_options：按父栏目分组的 <optgroup>。
//   label   = 父栏目「图标 名称」（optgroup 标题）
//   options = 父栏目自身（图标 名称）+ 其子栏目（　└ 图标 名称）
export interface CategoryGroup {
  label: string;
  options: CategoryOpt[];
}

interface Props {
  blogId: string;
  initialFeatured: boolean;
  initialCategoryId: number | null;
  categoryGroups: CategoryGroup[];
}

export default function AdminBlogActions({
  blogId,
  initialFeatured,
  initialCategoryId,
  categoryGroups,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const toast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    const w = window as unknown as { showToast?: (m: string, t: string) => void };
    if (w.showToast) w.showToast(msg, type);
  };

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/blogs/${blogId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(data.message || '操作成功', 'success');
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
    <>
      <select
        className="form-select category-select"
        data-article-id={blogId}
        value={initialCategoryId ?? ''}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value;
          patch({ categoryId: v === '' ? null : Number(v) });
        }}
      >
        <option value="">选择栏目</option>
        {categoryGroups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <div className="d-flex gap-1">
        <Link href={`/blog/${blogId}`} className="btn btn-sm btn-outline-primary" target="_blank">
          查看
        </Link>
        {/* TODO(no backend): Next 尚无文章编辑路由（仅 /blog/[id]），暂链到详情页，
            待迁移 /blog/[id]/edit 后改为编辑页。对齐 Flask manage_articles 的「编辑」按钮。 */}
        <Link href={`/blog/${blogId}`} className="btn btn-sm btn-outline-secondary">
          编辑
        </Link>
        <button
          className="btn btn-sm btn-outline-secondary toggle-featured"
          data-article-id={blogId}
          disabled={busy}
          onClick={() => patch({ isFeatured: !initialFeatured })}
        >
          {initialFeatured ? '取消精选' : '设为精选'}
        </button>
      </div>
    </>
  );
}
