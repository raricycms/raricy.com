// admin-category-service.ts —— 栏目管理业务逻辑
//
// 【为什么这么测】
// 栏目是站点结构（slug 是 URL 标识、父子决定侧栏层级、删除保护防误删），
// 这里钉的是「栏目管理」的语义契约：
//   · slug 一旦有内容（文章/子栏目）就锁定 —— 改名会断链；
//   · slug 字符集 [a-z0-9-] —— 它要进 URL，脏 slug 会让 /blog?category= 变丑/失效；
//   · 父级规则（仅二级、不能自指、有子栏目不许降级）—— 与删除保护同一批防线。
//
// 跑在临时 SQLite 上（tests/helpers/db.ts 有硬校验，不会碰真实库）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeCategory, makeBlog, prisma } from '../helpers/db';
import {
  createCategory,
  updateCategory,
  toggleCategoryActive,
  deleteCategory,
  listCategoriesTree,
  categoryToDict,
} from '@/lib/admin-category-service';

beforeEach(async () => {
  await resetDb();
});

/** 合法最小创建体：只改一个字段做单变量测试。 */
const baseInput = (over: Record<string, unknown> = {}) => ({
  name: '新栏目',
  slug: `new-cat-${Math.random().toString(36).slice(2, 8)}`,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. createCategory —— 名称/slug 校验 + 层级规则
// ─────────────────────────────────────────────────────────────────────────────

describe('createCategory 校验', () => {
  it('名称缺失 → 栏目名称不能为空', async () => {
    const r = await createCategory({ name: '  ', slug: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('栏目名称不能为空');
  });

  it('slug 缺失 → slug 不能为空', async () => {
    const r = await createCategory({ name: '栏目', slug: ' ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('slug 不能为空');
  });

  it('slug 含非法字符（大写/中文/下划线）→ 字符集文案', async () => {
    for (const slug of ['Academic', '我的栏目', 'a_b', 'a b', '学术版']) {
      const r = await createCategory({ name: '栏目', slug });
      expect(r.ok, `slug=${slug} 应被拒`).toBe(false);
      if (!r.ok) expect(r.message).toBe('slug 只能由小写字母、数字和连字符（-）组成');
    }
  });

  it('slug 重复（大小写不同也视为不同值，但字符集已禁大写）→ slug 已存在', async () => {
    const existing = await makeCategory({ slug: 'taken-slug' });
    const r = await createCategory({ name: '重复', slug: existing.slug });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('slug 已存在');
  });

  it('父栏目必须是存在的一级栏目', async () => {
    const r = await createCategory(baseInput({ parentId: 999999 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('父栏目不存在');
  });

  it('父栏目不能是二级栏目（仅支持两级）', async () => {
    const root = await makeCategory();
    const child = await makeCategory({ parentId: root.id });
    const r = await createCategory(baseInput({ parentId: child.id }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('仅支持二级分类，父栏目必须是一级栏目');
  });

  it('合法创建：根栏目 + 默认值齐全', async () => {
    const r = await createCategory({ name: '根栏目', slug: 'root-cat' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.parentId).toBeNull();
    expect(r.data.isActive).toBe(true);
    expect(r.data.excludeFromAll).toBe(false);
    expect(r.data.adminOnlyPosting).toBe(false);
    expect(r.data.notifyAdminOnPost).toBe(false);
    expect(r.data.sortOrder).toBe(0);
  });

  it('合法创建：父栏目下的二级栏目', async () => {
    const root = await makeCategory();
    const r = await createCategory({ name: '子栏目', slug: 'child-cat', parentId: root.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.parentId).toBe(root.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. updateCategory —— slug 锁定（本次新增的防线）与其他字段
// ─────────────────────────────────────────────────────────────────────────────

describe('updateCategory slug 锁定', () => {
  it('空栏目改 slug → 放行', async () => {
    const c = await makeCategory();
    const r = await updateCategory(c.id, { slug: 'renamed-empty' });
    expect(r.ok).toBe(true);
    const fresh = await prisma.category.findUnique({ where: { id: c.id } });
    expect(fresh?.slug).toBe('renamed-empty');
  });

  it('有文章（含 ignore=true 软删）的栏目改 slug → 锁定', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    const r = await updateCategory(c.id, { slug: 'should-lock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('栏目下已有文章或子栏目，slug 不可修改');

    // 软删文章同样锁定（与 deleteCategory 的计数口径一致，都不过滤 ignore）
    await makeBlog({ categoryId: c.id, ignore: true });
    const r2 = await updateCategory(c.id, { slug: 'should-lock-2' });
    expect(r2.ok).toBe(false);
  });

  it('有子栏目的栏目改 slug → 锁定', async () => {
    const root = await makeCategory();
    await makeCategory({ parentId: root.id });
    const r = await updateCategory(root.id, { slug: 'should-lock' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('栏目下已有文章或子栏目，slug 不可修改');
  });

  it('slug 不变（与现值相同）→ 不触发锁定', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    const r = await updateCategory(c.id, { slug: c.slug });
    expect(r.ok).toBe(true);
  });

  it('锁定状态下改名（非 slug 字段）照常放行', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    const r = await updateCategory(c.id, { name: '改名但不动 slug' });
    expect(r.ok).toBe(true);
    const fresh = await prisma.category.findUnique({ where: { id: c.id } });
    expect(fresh?.slug).toBe(c.slug);
  });

  it('非法字符 slug 在更新时同样被拒', async () => {
    const c = await makeCategory();
    const r = await updateCategory(c.id, { slug: 'Bad Slug' });
    expect(r.ok).toBe(false);
  });
});

describe('updateCategory 父级规则', () => {
  it('父栏目不能是自身', async () => {
    const c = await makeCategory();
    const r = await updateCategory(c.id, { parentId: c.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('父栏目不能是自身');
  });

  it('有子栏目的一级栏目不能降级为二级', async () => {
    const rootA = await makeCategory();
    const rootB = await makeCategory();
    await makeCategory({ parentId: rootA.id });
    const r = await updateCategory(rootA.id, { parentId: rootB.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('该栏目下仍有子栏目，无法改为二级栏目');
  });

  it('没有子栏目的一级栏目可降级为二级', async () => {
    const rootA = await makeCategory();
    const rootB = await makeCategory();
    const r = await updateCategory(rootA.id, { parentId: rootB.id });
    expect(r.ok).toBe(true);
    const fresh = await prisma.category.findUnique({ where: { id: rootA.id } });
    expect(fresh?.parentId).toBe(rootB.id);
  });

  it('二级栏目可升为一级（parentId=null）', async () => {
    const root = await makeCategory();
    const child = await makeCategory({ parentId: root.id });
    const r = await updateCategory(child.id, { parentId: null });
    expect(r.ok).toBe(true);
    const fresh = await prisma.category.findUnique({ where: { id: child.id } });
    expect(fresh?.parentId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. toggleCategoryActive / deleteCategory / 列表
// ─────────────────────────────────────────────────────────────────────────────

describe('toggleCategoryActive', () => {
  it('启用 ↔ 停用切换', async () => {
    const c = await makeCategory();
    const r1 = await toggleCategoryActive(c.id);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.isActive).toBe(false);
    const r2 = await toggleCategoryActive(c.id);
    if (r2.ok) expect(r2.data.isActive).toBe(true);
  });
});

describe('deleteCategory 阻断', () => {
  it('有文章不能删（含软删文章）', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    const r = await deleteCategory(c.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('篇文章');

    const c2 = await makeCategory();
    await makeBlog({ categoryId: c2.id, ignore: true });
    const r2 = await deleteCategory(c2.id);
    expect(r2.ok).toBe(false);
  });

  it('有子栏目不能删', async () => {
    const root = await makeCategory();
    await makeCategory({ parentId: root.id });
    const r = await deleteCategory(root.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('个子栏目');
  });

  it('空栏目可删', async () => {
    const c = await makeCategory();
    const r = await deleteCategory(c.id);
    expect(r.ok).toBe(true);
    expect(await prisma.category.findUnique({ where: { id: c.id } })).toBeNull();
  });
});

describe('listCategoriesTree / categoryToDict', () => {
  it('返回一级 + 二级树，带文章与子栏目计数', async () => {
    const root = await makeCategory({ name: '根' });
    const child = await makeCategory({ name: '子', parentId: root.id });
    await makeBlog({ categoryId: root.id });
    await makeBlog({ categoryId: child.id });
    await makeBlog({ categoryId: child.id });

    const tree = await listCategoriesTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('根');
    expect(tree[0].blog_count).toBe(1);
    expect(tree[0].child_count).toBe(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].blog_count).toBe(2);
    expect(tree[0].children[0].level).toBe(2);
  });

  it('categoryToDict 字段形状（snake_case + level）', async () => {
    const c = await prisma.category.create({
      data: {
        name: 'x',
        slug: 'x',
        description: null,
        icon: '',
        parentId: null,
        sortOrder: 3,
        isActive: false,
        excludeFromAll: true,
        adminOnlyPosting: false,
        notifyAdminOnPost: false,
      },
    });
    const d = categoryToDict(c);
    expect(d).toMatchObject({
      id: c.id,
      name: 'x',
      parent_id: null,
      sort_order: 3,
      is_active: false,
      exclude_from_all: true,
      admin_only_posting: false,
      notify_admin_on_post: false,
      level: 1,
    });
  });
});
