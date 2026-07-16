import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { listCategoriesTree, createCategory, categoryToDict } from '@/lib/admin-category-service';

async function requireAdmin() {
  const user = await getCurrentUser();
  return hasAdminRights(user) ? user : null;
}

// GET /api/admin/categories — 层级列表（含未启用 + 文章计数）
export async function GET() {
  if (!(await requireAdmin())) return apiErr(403, '需要管理员权限');
  const categories = await listCategoriesTree();
  return apiOk({ categories });
}

// POST /api/admin/categories — 创建栏目
export async function POST(req: Request) {
  if (!(await requireAdmin())) return apiErr(403, '需要管理员权限');

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const parentIdRaw = body.parentId ?? body.parent_id;
  const result = await createCategory({
    name: String(body.name ?? ''),
    slug: String(body.slug ?? ''),
    description: body.description != null ? String(body.description) : undefined,
    icon: body.icon != null ? String(body.icon) : undefined,
    parentId: parentIdRaw == null || parentIdRaw === '' ? null : Number(parentIdRaw),
    sortOrder: body.sortOrder != null ? Number(body.sortOrder) : undefined,
    isActive: body.isActive != null ? Boolean(body.isActive) : undefined,
    excludeFromAll: body.excludeFromAll != null ? Boolean(body.excludeFromAll) : undefined,
    adminOnlyPosting: body.adminOnlyPosting != null ? Boolean(body.adminOnlyPosting) : undefined,
    notifyAdminOnPost: body.notifyAdminOnPost != null ? Boolean(body.notifyAdminOnPost) : undefined,
  });

  if (!result.ok) return apiErr(400, result.message);
  return apiOk({ category: categoryToDict(result.data) }, '栏目创建成功');
}
