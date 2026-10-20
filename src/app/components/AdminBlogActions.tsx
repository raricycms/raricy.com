'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminBlogActions — 文章列表单行的操作簇：
//   栏目下拉 + 查看 + 编辑 + 设为精选 / 取消精选。
//   改栏目 / 切精选走 PATCH /api/admin/blogs/:id，成功后 router.refresh() 让服务端
//   重渲染，效果与就地更新分类徽标 / 精选标记相同。
//
// ⚠️ 栏目下拉的「未分类」用 'none' 作值：旧实现里「选择栏目」与「设为未分类」
//   都是 value=""，受控 select 永远匹配第一条，第二项等于点不到。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, Pencil, Star, StarOff } from 'lucide-react';

export interface CategoryOpt {
  id: number;
  label: string; // 含图标前缀；子栏目形如「　└ 图标 名称」
}

// 栏目下拉数据：按父栏目分组的 <optgroup>。
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
    <div className="admin-blog-actions">
      <select
        className="form-select admin-blog-actions__select"
        data-article-id={blogId}
        value={initialCategoryId ?? 'none'}
        disabled={busy}
        aria-label="文章栏目"
        onChange={(e) => {
          const v = e.target.value;
          patch({ categoryId: v === 'none' ? null : Number(v) });
        }}
      >
        <option value="none">未分类</option>
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

      <div className="admin-blog-actions__buttons">
        <Link
          href={`/blog/${blogId}`}
          className="admin-blog-actions__btn"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Eye aria-hidden="true" />
          查看
        </Link>
        <Link href={`/blog/${blogId}/edit`} className="admin-blog-actions__btn">
          <Pencil aria-hidden="true" />
          编辑
        </Link>
        <button
          type="button"
          className={`admin-blog-actions__btn${initialFeatured ? ' is-active' : ''}`}
          data-article-id={blogId}
          disabled={busy}
          onClick={() => patch({ isFeatured: !initialFeatured })}
        >
          {initialFeatured ? <StarOff aria-hidden="true" /> : <Star aria-hidden="true" />}
          {initialFeatured ? '取消精选' : '设为精选'}
        </button>
      </div>
    </div>
  );
}
