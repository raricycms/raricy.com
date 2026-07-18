'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminCategoryEditor — 栏目管理交互组件
//   • 层级列表（一级 + 子级），每行显示文章/子栏目计数
//   • 创建 / 编辑（弹出表单）/ 删除（阻断有子栏目或文章的）/ 启用切换
//   • 所有写操作走 /api/admin/categories[...]，成功后 router.refresh() 重新拉服务端数据
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CategoryNode {
  id: number;
  name: string;
  slug: string;
  description: string;
  parent_id: number | null;
  sort_order: number;
  is_active: boolean;
  icon: string;
  exclude_from_all: boolean;
  admin_only_posting: boolean;
  notify_admin_on_post: boolean;
  level: number;
  blog_count: number;
  child_count: number;
  children?: CategoryNode[];
}

interface ParentOption {
  id: number;
  name: string;
  icon?: string;
}

interface Props {
  initialCategories: CategoryNode[];
  initialParents: ParentOption[];
}

interface FormState {
  id: number | null; // null = 新建
  name: string;
  slug: string;
  description: string;
  icon: string;
  parentId: string; // '' = 一级栏目
  sortOrder: string;
  isActive: boolean;
  excludeFromAll: boolean;
  adminOnlyPosting: boolean;
  notifyAdminOnPost: boolean;
}

const emptyForm = (parentId = ''): FormState => ({
  id: null,
  name: '',
  slug: '',
  description: '',
  icon: '',
  parentId,
  sortOrder: '0',
  isActive: true,
  excludeFromAll: false,
  adminOnlyPosting: false,
  notifyAdminOnPost: false,
});

function toForm(c: CategoryNode): FormState {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    icon: c.icon,
    parentId: c.parent_id != null ? String(c.parent_id) : '',
    sortOrder: String(c.sort_order),
    isActive: c.is_active,
    excludeFromAll: c.exclude_from_all,
    adminOnlyPosting: c.admin_only_posting,
    notifyAdminOnPost: c.notify_admin_on_post,
  };
}

export default function AdminCategoryEditor({ initialCategories, initialParents }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    if (typeof window !== 'undefined' && (window as unknown as { showToast?: (m: string, t: string) => void }).showToast) {
      (window as unknown as { showToast: (m: string, t: string) => void }).showToast(msg, type);
    }
  };

  async function save() {
    if (!form) return;
    setError('');
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        slug: form.slug,
        description: form.description,
        icon: form.icon,
        parentId: form.parentId === '' ? null : Number(form.parentId),
        sortOrder: Number(form.sortOrder) || 0,
        isActive: form.isActive,
        excludeFromAll: form.excludeFromAll,
        adminOnlyPosting: form.adminOnlyPosting,
        notifyAdminOnPost: form.notifyAdminOnPost,
      };
      const url = form.id == null ? '/api/admin/categories' : `/api/admin/categories/${form.id}`;
      const method = form.id == null ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(form.id == null ? '栏目已创建' : '栏目已更新', 'success');
        setForm(null);
        router.refresh();
      } else {
        setError(data.message || '操作失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(c: CategoryNode) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/categories/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'toggle-active' }),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast('状态已更新', 'success');
        router.refresh();
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: CategoryNode) {
    if (c.blog_count > 0) {
      toast(`无法删除，该栏目下还有 ${c.blog_count} 篇文章`, 'error');
      return;
    }
    if (c.child_count > 0) {
      toast(`无法删除，该栏目下还有 ${c.child_count} 个子栏目`, 'error');
      return;
    }
    if (!window.confirm(`确定删除栏目「${c.name}」？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/categories/${c.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        toast('栏目已删除', 'success');
        router.refresh();
      } else {
        toast(data.message || '删除失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setBusy(false);
    }
  }

  const flags = (c: CategoryNode) => {
    const tags: string[] = [];
    if (c.exclude_from_all) tags.push('不进全部');
    if (c.admin_only_posting) tags.push('仅管理员发文');
    if (c.notify_admin_on_post) tags.push('发文通知管理员');
    return tags;
  };

  const renderRow = (c: CategoryNode, child: boolean) => (
    <div
      key={c.id}
      className="article-card"
      style={{ opacity: c.is_active ? 1 : 0.55, marginLeft: child ? 28 : 0 }}
    >
      <div className="article-card__header">
        <div className="article-card__info">
          <div className="d-flex align-items-center gap-2 mb-1" style={{ flexWrap: 'wrap' }}>
            <span className="article-card__title" style={{ marginBottom: 0 }}>
              {child ? '└ ' : ''}
              {c.icon ? `${c.icon} ` : ''}
              {c.name}
            </span>
            <code className="mono" style={{ fontSize: '.8rem', color: 'var(--ink-3)' }}>{c.slug}</code>
            {!c.is_active && <span className="badge-danger">已停用</span>}
            {flags(c).map((t) => (
              <span key={t} className="badge-secondary">
                {t}
              </span>
            ))}
          </div>
          <div className="article-card__meta">
            <span>{c.blog_count} 篇文章</span>
            {!child && <span>{c.child_count} 个子栏目</span>}
            {c.description && <span>{c.description}</span>}
          </div>
        </div>
        <div className="article-card__actions">
          <div className="d-flex gap-1" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => setForm(toForm(c))}>
              编辑
            </button>
            <button className="btn btn-sm btn-outline-secondary" disabled={busy} onClick={() => toggleActive(c)}>
              {c.is_active ? '停用' : '启用'}
            </button>
            <button
              className="btn btn-sm btn-outline-danger"
              disabled={busy || c.blog_count > 0 || c.child_count > 0}
              title={
                c.blog_count > 0 ? '该栏目下仍有文章' : c.child_count > 0 ? '该栏目下仍有子栏目' : ''
              }
              onClick={() => remove(c)}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className="d-flex justify-content-end mb-3">
        <button className="btn btn-primary" disabled={busy} onClick={() => setForm(emptyForm())}>
          + 新建栏目
        </button>
      </div>

      {initialCategories.length === 0 && (
        <div className="text-center text-muted py-5">暂无栏目</div>
      )}
      {initialCategories.map((root) => (
        <div key={root.id}>
          {renderRow(root, false)}
          {(root.children ?? []).map((c) => renderRow(c, true))}
        </div>
      ))}

      {form && (
        <div className="modal-overlay show" onClick={() => !busy && setForm(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">{form.id == null ? '新建栏目' : '编辑栏目'}</h3>
                <button type="button" className="btn-close" disabled={busy} onClick={() => setForm(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">名称</label>
                  <input
                    className="form-control"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">slug（唯一）</label>
                  <input
                    className="form-control"
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">父栏目</label>
                  {/* 父栏目仅可选一级栏目（二级层级，子栏目不可再作父级），
                      故此处按 Flask render_category_options 的样式给每项加图标前缀；
                      因无可选子级，不出现「　└ 名称」子项。 */}
                  <select
                    className="form-select"
                    value={form.parentId}
                    onChange={(e) => setForm({ ...form, parentId: e.target.value })}
                  >
                    <option value="">（一级栏目）</option>
                    {initialParents
                      .filter((p) => p.id !== form.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.icon ? `${p.icon} ${p.name}` : p.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">图标（可选）</label>
                  <input
                    className="form-control"
                    value={form.icon}
                    onChange={(e) => setForm({ ...form, icon: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">排序权重</label>
                  <input
                    type="number"
                    className="form-control"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">描述（可选）</label>
                  <input
                    className="form-control"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>

                <label className="d-flex align-items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  />
                  启用
                </label>
                <label className="d-flex align-items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    checked={form.excludeFromAll}
                    onChange={(e) => setForm({ ...form, excludeFromAll: e.target.checked })}
                  />
                  从“全部文章”中排除
                </label>
                <label className="d-flex align-items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    checked={form.adminOnlyPosting}
                    onChange={(e) => setForm({ ...form, adminOnlyPosting: e.target.checked })}
                  />
                  仅管理员可发文
                </label>
                <label className="d-flex align-items-center gap-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    checked={form.notifyAdminOnPost}
                    onChange={(e) => setForm({ ...form, notifyAdminOnPost: e.target.checked })}
                  />
                  发文时通知管理员
                </label>

                {error && <p className="text-danger mt-3" style={{ fontSize: '.85rem' }}>{error}</p>}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setForm(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
                  {busy ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
