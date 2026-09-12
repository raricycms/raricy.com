import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import {
  deleteBlogForAdmin,
  setBlogFeatured,
  setBlogIgnore,
  setBlogCategory,
} from '@/lib/admin-blog-service';

// PATCH /api/admin/blogs/:id — 精选切换 / 软删除·恢复 / 改栏目
// body 支持任意组合（互斥字段各自处理）：
//   { isFeatured: boolean }         → 设置精选
//   { ignore: boolean }             → 软删除(true) / 恢复(false)
//   { categoryId: number | null }   → 改栏目（null=未分类）
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '需要管理员权限');

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  if ('isFeatured' in body) {
    const result = await setBlogFeatured(id, Boolean(body.isFeatured));
    if (!result.ok) return apiErr(404, result.message);
    return apiOk({ blog: result.data }, result.data.isFeatured ? '已设为精选' : '已取消精选');
  }

  if ('ignore' in body) {
    const result = await setBlogIgnore(id, Boolean(body.ignore));
    if (!result.ok) return apiErr(404, result.message);
    return apiOk({ blog: result.data }, result.data.ignore ? '文章已删除' : '文章已恢复');
  }

  if ('categoryId' in body || 'category_id' in body) {
    const raw = 'categoryId' in body ? body.categoryId : body.category_id;
    const categoryId = raw == null || raw === '' ? null : Number(raw);
    if (categoryId != null && !Number.isInteger(categoryId)) {
      return apiErr(400, '栏目 ID 格式错误');
    }
    const result = await setBlogCategory(id, categoryId);
    if (!result.ok) {
      const code = result.message === '文章不存在' ? 404 : 400;
      return apiErr(code, result.message);
    }
    return apiOk({ blog: result.data }, `文章栏目已更改为 "${result.data.categoryName}"`);
  }

  return apiErr(400, '无可更新的字段');
}

// DELETE /api/admin/blogs/:id — 管理员删他人文章
// body: { reason: string }  (必填，对齐 Flask：管理员删帖必须填理由、记日志、通知作者)
// 作者本人删自己的文章请走 /api/blogs/:id，不写日志不强制 reason。
//
// 具体动作（软删 + 审计 + 通知作者）在 admin-blog-service.deleteBlogForAdmin ——
// 运维 CLI 走的是同一个函数，避免三件事各出现第二份实现。
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '需要管理员权限');

  const { id } = await ctx.params;

  let body: { reason?: string } | null = null;
  try {
    body = (await req.json()) as { reason?: string };
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const result = await deleteBlogForAdmin(id, user!, (body?.reason ?? '').trim());
  if (!result.ok) return apiErr(result.code, result.message);
  return apiOk({ blog: { id: result.id, ignore: result.ignore } }, result.message);
}
