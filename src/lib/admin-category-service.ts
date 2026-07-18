// ─────────────────────────────────────────────────────────────────────────────
// admin-category-service.ts — 栏目管理业务逻辑（对齐 Flask CategoryService）
//
// 与 Flask 解耦风格一致：纯函数 + 显式参数。
// 删除采用物理删除（对齐 CategoryService.delete_category），但会先阻断：
//   • 该栏目下仍有文章（含 ignore=true 的软删除文章，与 Flask 一致，Flask 不带 ignore 过滤）
//   • 该栏目下仍有子栏目
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import type { Category } from '@prisma/client';

export interface CategoryInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  parentId?: number | null;
  sortOrder?: number;
  isActive?: boolean;
  excludeFromAll?: boolean;
  adminOnlyPosting?: boolean;
  notifyAdminOnPost?: boolean;
}

export type ServiceResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** 序列化为前端友好的字典（对齐 Category.to_dict）。 */
export function categoryToDict(c: Category) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description ?? '',
    parent_id: c.parentId,
    sort_order: c.sortOrder ?? 0,
    is_active: c.isActive ?? true,
    icon: c.icon ?? '',
    exclude_from_all: c.excludeFromAll ?? false,
    admin_only_posting: c.adminOnlyPosting ?? false,
    notify_admin_on_post: c.notifyAdminOnPost ?? false,
    level: c.parentId == null ? 1 : 2,
  };
}

/**
 * 层级列表：一级栏目（parentId=null）+ 其子栏目，各带文章数量。
 * 与 Flask get_hierarchy 不同的是：这里管理端要看到所有栏目（含未启用），
 * 且附带文章计数用于删除判断展示。
 */
export async function listCategoriesTree() {
  const all = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { blogs: true, children: true } } },
  });

  const roots = all.filter((c) => c.parentId == null);
  const childrenOf = (pid: number) => all.filter((c) => c.parentId === pid);

  return roots.map((root) => ({
    ...categoryToDict(root),
    blog_count: root._count.blogs,
    child_count: root._count.children,
    children: childrenOf(root.id).map((child) => ({
      ...categoryToDict(child),
      blog_count: child._count.blogs,
      child_count: child._count.children,
    })),
  }));
}

/** 扁平列表（供下拉选项 / 文章改栏目使用）。 */
export async function listCategoriesFlat() {
  const all = await prisma.category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { parent: { select: { name: true } } },
  });
  return all.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    parent_id: c.parentId,
    is_active: c.isActive ?? true,
    level: c.parentId == null ? 1 : 2,
    full_path: c.parentId != null && c.parent ? `${c.parent.name} > ${c.name}` : c.name,
  }));
}

async function slugTaken(slug: string, exceptId?: number): Promise<boolean> {
  const found = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
  if (!found) return false;
  return exceptId == null || found.id !== exceptId;
}

/** 校验 parentId 合法（存在且本身是一级栏目，避免三级嵌套）。 */
async function validateParent(parentId: number | null | undefined, selfId?: number): Promise<ServiceResult> {
  if (parentId == null) return { ok: true, data: undefined };
  if (selfId != null && parentId === selfId) return { ok: false, message: '父栏目不能是自身' };
  const parent = await prisma.category.findUnique({
    where: { id: parentId },
    select: { id: true, parentId: true },
  });
  if (!parent) return { ok: false, message: '父栏目不存在' };
  if (parent.parentId != null) return { ok: false, message: '仅支持二级分类，父栏目必须是一级栏目' };
  return { ok: true, data: undefined };
}

export async function createCategory(input: CategoryInput): Promise<ServiceResult<Category>> {
  const name = input.name?.trim();
  const slug = input.slug?.trim();
  if (!name) return { ok: false, message: '栏目名称不能为空' };
  if (!slug) return { ok: false, message: 'slug 不能为空' };
  if (await slugTaken(slug)) return { ok: false, message: 'slug 已存在' };

  const parentCheck = await validateParent(input.parentId);
  if (!parentCheck.ok) return parentCheck;

  const category = await prisma.category.create({
    data: {
      name,
      slug,
      description: input.description ?? '',
      icon: input.icon ?? '',
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
      excludeFromAll: input.excludeFromAll ?? false,
      adminOnlyPosting: input.adminOnlyPosting ?? false,
      notifyAdminOnPost: input.notifyAdminOnPost ?? false,
      createdAt: nowForDb(),
    },
  });
  return { ok: true, data: category };
}

export async function updateCategory(
  id: number,
  input: Partial<CategoryInput>
): Promise<ServiceResult<Category>> {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) return { ok: false, message: '栏目不存在' };

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, message: '栏目名称不能为空' };
    data.name = name;
  }
  if (input.slug !== undefined) {
    const slug = input.slug.trim();
    if (!slug) return { ok: false, message: 'slug 不能为空' };
    if (await slugTaken(slug, id)) return { ok: false, message: 'slug 已存在' };
    data.slug = slug;
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.excludeFromAll !== undefined) data.excludeFromAll = input.excludeFromAll;
  if (input.adminOnlyPosting !== undefined) data.adminOnlyPosting = input.adminOnlyPosting;
  if (input.notifyAdminOnPost !== undefined) data.notifyAdminOnPost = input.notifyAdminOnPost;

  if (input.parentId !== undefined) {
    const parentCheck = await validateParent(input.parentId, id);
    if (!parentCheck.ok) return parentCheck;
    // 若本栏目下已有子栏目，则不能把它变成二级栏目（否则出现三级）
    if (input.parentId != null) {
      const childCount = await prisma.category.count({ where: { parentId: id } });
      if (childCount > 0) {
        return { ok: false, message: '该栏目下仍有子栏目，无法改为二级栏目' };
      }
    }
    data.parentId = input.parentId;
  }

  const category = await prisma.category.update({ where: { id }, data });
  return { ok: true, data: category };
}

/** 切换启用状态。 */
export async function toggleCategoryActive(id: number): Promise<ServiceResult<Category>> {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) return { ok: false, message: '栏目不存在' };
  const category = await prisma.category.update({
    where: { id },
    data: { isActive: !(existing.isActive ?? true) },
  });
  return { ok: true, data: category };
}

/** 物理删除（对齐 CategoryService.delete_category），有子栏目或文章则阻断。 */
export async function deleteCategory(id: number): Promise<ServiceResult> {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) return { ok: false, message: '栏目不存在' };

  const blogCount = await prisma.blog.count({ where: { categoryId: id } });
  if (blogCount > 0) {
    return { ok: false, message: `无法删除，该栏目下还有 ${blogCount} 篇文章` };
  }
  const childCount = await prisma.category.count({ where: { parentId: id } });
  if (childCount > 0) {
    return { ok: false, message: `无法删除，该栏目下还有 ${childCount} 个子栏目` };
  }

  await prisma.category.delete({ where: { id } });
  return { ok: true, data: undefined };
}
