'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminBlogActions — 文章列表单行的操作簇：
//   栏目下拉 + 查看 + 编辑 + 设为精选 / 取消精选。
//   改栏目 / 切精选走 PATCH /api/admin/blogs/:id，成功后 router.refresh() 让服务端
//   重渲染，效果与就地更新分类徽标 / 精选标记相同。
//
// 栏目下拉直接复用筛选条的 <BlogCategorySelect>（传 onSelect，不写 URL）：
// 两处的栏目树、图标前缀与展开方式因此始终一致。行内用它「改这篇的栏目」，
// 所以去掉「全部栏目」、把「未分类」作为固定选项。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, Pencil, Star, StarOff } from 'lucide-react';
import BlogCategorySelect, { type BlogCategoryExtraOption, type BlogCategoryOption } from '@/app/blog/BlogCategorySelect';

export interface CategoryOpt {
  id: number;
  label: string; // 含图标前缀；子栏目形如「　└ 图标 名称」
}

// 栏目下拉数据：按父栏目分组的 <optgroup>（批量底座仍用原生 select）。
export interface CategoryGroup {
  label: string;
  options: CategoryOpt[];
}

const UNCATEGORIZED_OPTION: BlogCategoryExtraOption[] = [
  { value: 'none', label: '未分类' },
];

interface Props {
  blogId: string;
  initialFeatured: boolean;
  initialCategoryId: number | null;
  categoryOptions: BlogCategoryOption[];
}

export default function AdminBlogActions({
  blogId,
  initialFeatured,
  initialCategoryId,
  categoryOptions,
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
      {/* 卡片底部一行：左边改栏目、右边行内动作。可见的「栏目」标签说明这个下拉
          改的是当前这篇的归属，而不是页面筛选。 */}
      <div className="admin-blog-actions__field">
        <span className="admin-blog-actions__label">栏目</span>
        <BlogCategorySelect
          align="start"
          showAll={false}
          showFeatured={false}
          disabled={busy}
          categories={categoryOptions}
          currentValue={initialCategoryId == null ? 'none' : String(initialCategoryId)}
          extraOptions={UNCATEGORIZED_OPTION}
          onSelect={(value) => patch({ categoryId: value && value !== 'none' ? Number(value) : null })}
        />
      </div>

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
