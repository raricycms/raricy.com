import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import {
  updateCategory,
  deleteCategory,
  toggleCategoryActive,
  categoryToDict,
} from '@/lib/admin-category-service';

async function requireAdmin() {
  const user = await getCurrentUser();
  return hasAdminRights(user) ? user : null;
}

// PATCH /api/admin/categories/:id — 更新栏目；action=toggle-active 时仅切换启用状态
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return apiErr(403, '需要管理员权限');

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) return apiErr(400, '栏目 ID 无效');

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  if (body.action === 'toggle-active') {
    const result = await toggleCategoryActive(id);
    if (!result.ok) return apiErr(404, result.message);
    return apiOk({ category: categoryToDict(result.data) }, '状态已更新');
  }

  const parentIdRaw = body.parentId ?? body.parent_id;
  const result = await updateCategory(id, {
    name: body.name != null ? String(body.name) : undefined,
    slug: body.slug != null ? String(body.slug) : undefined,
    description: body.description != null ? String(body.description) : undefined,
    icon: body.icon != null ? String(body.icon) : undefined,
    parentId:
      parentIdRaw === undefined
        ? undefined
        : parentIdRaw == null || parentIdRaw === ''
          ? null
          : Number(parentIdRaw),
    sortOrder: body.sortOrder != null ? Number(body.sortOrder) : undefined,
    isActive: body.isActive != null ? Boolean(body.isActive) : undefined,
    excludeFromAll: body.excludeFromAll != null ? Boolean(body.excludeFromAll) : undefined,
    adminOnlyPosting: body.adminOnlyPosting != null ? Boolean(body.adminOnlyPosting) : undefined,
    notifyAdminOnPost: body.notifyAdminOnPost != null ? Boolean(body.notifyAdminOnPost) : undefined,
  });

  if (!result.ok) {
    const code = result.message === '栏目不存在' ? 404 : 400;
    return apiErr(code, result.message);
  }
  return apiOk({ category: categoryToDict(result.data) }, '栏目已更新');
}

// DELETE /api/admin/categories/:id — 物理删除（有子栏目/文章则阻断）
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await requireAdmin())) return apiErr(403, '需要管理员权限');

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) return apiErr(400, '栏目 ID 无效');

  const result = await deleteCategory(id);
  if (!result.ok) {
    const code = result.message === '栏目不存在' ? 404 : 400;
    return apiErr(code, result.message);
  }
  return apiOk({}, '栏目删除成功');
}
