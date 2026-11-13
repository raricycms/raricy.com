// admin-category-service.ts —— 栏目管理业务逻辑
//
// 【为什么这么测】
// 栏目是站点结构（slug 是 URL 标识、父子决定侧栏层级、删除保护防误删），
// 这里钉的是「栏目管理」的语义契约：
//   · slug 一旦有内容（文章/子栏目）就锁定 —— 改名会断链；
//   · slug 字符集 [a-z0-9-] —— 它要进 URL，脏 slug 会让 /blog?category= 变丑/失效；
//   · 父级规则（仅二级、不能自指、有子栏目不许降级）—— 与删除保护同一批防线。
//
// 只断言「接受 / 拒绝 + 落库结果」，不钉中文文案错误提示（站长口径：前端文案不写测试）。
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
  it('非法输入一律拒绝：名称空 / slug 空 / slug 非法字符 / slug 重复 / 父栏目不存在', async () => {
    const existing = await makeCategory({ slug: 'taken-slug' });
    const cases: { label: string; input: { name: string; slug: string; parentId?: number } }[] = [
      { label: '名称空白', input: { name: '  ', slug: 'name-blank' } },
      { label: 'slug 空白', input: { name: '栏目', slug: ' ' } },
      { label: 'slug 大写', input: { name: '栏目', slug: 'Academic' } },
      { label: 'slug 中文', input: { name: '栏目', slug: '我的栏目' } },
      { label: 'slug 下划线', input: { name: '栏目', slug: 'a_b' } },
      { label: 'slug 空格', input: { name: '栏目', slug: 'a b' } },
      { label: 'slug 重复', input: { name: '栏目', slug: existing.slug } },
      { label: '父栏目不存在', input: { name: '栏目', slug: 'no-such-parent', parentId: 999999 } },
    ];
    for (const { label, input } of cases) {
      const r = await createCategory(input);
      expect(r.ok, `应被拒：${label}`).toBe(false);
    }
  });

  it('父栏目不能是二级栏目（仅支持两级）', async () => {
    const root = await makeCategory();
    const child = await makeCategory({ parentId: root.id });
    const r = await createCategory(baseInput({ parentId: child.id }));
    expect(r.ok).toBe(false);
  });

  it('合法创建：根栏目默认值齐全；二级栏目继承 parentId', async () => {
    const rootCreated = await createCategory({ name: '根栏目', slug: 'root-cat' });
    expect(rootCreated.ok).toBe(true);
    if (!rootCreated.ok) return;
    expect(rootCreated.data).toMatchObject({
      parentId: null,
      isActive: true,
      excludeFromAll: false,
      adminOnlyPosting: false,
      notifyAdminOnPost: false,
      focusHidden: false,
      sortOrder: 0,
    });

    const root = await makeCategory();
    const child = await createCategory({ name: '子栏目', slug: 'child-cat', parentId: root.id });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.data.parentId).toBe(root.id);
  });
});

describe('状态字段往返落库', () => {
  it('focusHidden 开→关、缺省不动原值；isActive 启用↔停用', async () => {
    const c = await makeCategory();
    expect((await updateCategory(c.id, { focusHidden: true })).ok).toBe(true);
    expect((await prisma.category.findUnique({ where: { id: c.id } }))?.focusHidden).toBe(true);
    expect((await updateCategory(c.id, { focusHidden: false })).ok).toBe(true);
    expect((await prisma.category.findUnique({ where: { id: c.id } }))?.focusHidden).toBe(false);

    // 缺省分支：不传 focusHidden 时保持原值
    const hidden = await makeCategory({ focusHidden: true });
    expect((await updateCategory(hidden.id, { name: '只改名' })).ok).toBe(true);
    expect((await prisma.category.findUnique({ where: { id: hidden.id } }))?.focusHidden).toBe(true);

    const off = await toggleCategoryActive(c.id);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.data.isActive).toBe(false);
    const on = await toggleCategoryActive(c.id);
    if (on.ok) expect(on.data.isActive).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. updateCategory —— slug 锁定与其他字段
// ─────────────────────────────────────────────────────────────────────────────

describe('updateCategory slug 锁定', () => {
  it('空栏目改 slug → 放行', async () => {
    const c = await makeCategory();
    const r = await updateCategory(c.id, { slug: 'renamed-empty' });
    expect(r.ok).toBe(true);
    const fresh = await prisma.category.findUnique({ where: { id: c.id } });
    expect(fresh?.slug).toBe('renamed-empty');
  });

  it('有文章（含 ignore=true 软删）的栏目改 slug → 锁定且原值不变', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    const r = await updateCategory(c.id, { slug: 'should-lock' });
    expect(r.ok).toBe(false);
    expect((await prisma.category.findUnique({ where: { id: c.id } }))?.slug).toBe(c.slug);

    // 软删文章同样锁定（与 deleteCategory 的计数口径一致，都不过滤 ignore）
    const c2 = await makeCategory();
    await makeBlog({ categoryId: c2.id, ignore: true });
    const r2 = await updateCategory(c2.id, { slug: 'should-lock-2' });
    expect(r2.ok).toBe(false);
  });

  it('有子栏目的栏目改 slug → 锁定且原值不变', async () => {
    const root = await makeCategory();
    await makeCategory({ parentId: root.id });
    const r = await updateCategory(root.id, { slug: 'should-lock' });
    expect(r.ok).toBe(false);
    expect((await prisma.category.findUnique({ where: { id: root.id } }))?.slug).toBe(root.slug);
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
});

describe('updateCategory 父级规则', () => {
  it('父栏目不能是自身', async () => {
    const c = await makeCategory();
    const r = await updateCategory(c.id, { parentId: c.id });
    expect(r.ok).toBe(false);
  });

  it('有子栏目的一级栏目不能降级为二级', async () => {
    const rootA = await makeCategory();
    const rootB = await makeCategory();
    await makeCategory({ parentId: rootA.id });
    const r = await updateCategory(rootA.id, { parentId: rootB.id });
    expect(r.ok).toBe(false);
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
// 3. deleteCategory / 列表
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteCategory 阻断', () => {
  it('有文章不能删（含软删文章）', async () => {
    const c = await makeCategory();
    await makeBlog({ categoryId: c.id });
    expect((await deleteCategory(c.id)).ok).toBe(false);

    const c2 = await makeCategory();
    await makeBlog({ categoryId: c2.id, ignore: true });
    expect((await deleteCategory(c2.id)).ok).toBe(false);
  });

  it('有子栏目不能删', async () => {
    const root = await makeCategory();
    await makeCategory({ parentId: root.id });
    expect((await deleteCategory(root.id)).ok).toBe(false);
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
});
