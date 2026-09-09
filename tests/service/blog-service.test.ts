// blog-service.ts —— 博客业务逻辑（对齐 Flask BlogService / BlogValidator）
//
// 【为什么这么测】
// 这一层是迁移的「语义契约」：Next 侧必须和 Flask 产出逐字一致的校验文案、
// 一致的日限额边界、一致的软删除过滤。文案一旦漂移，前端提示就和老站不一样；
// 边界一旦漂移，用户要么被多拦一篇要么被多放一篇。所以这里的断言大量用
// 「钉死字面量」而非 toContain —— 目的就是让任何无意的措辞改动直接红。
//
// 跑在临时 SQLite 上（tests/helpers/db.ts 有硬校验，不会碰真实库）。
//
// ⚠️ 本文件中标注【与 Flask 不一致】的用例，钉的是**当前实现的实际行为**，
//    不是期望行为。修复源码时这些断言应当被翻转 —— 详见交付说明。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, makeCategory, prisma } from '../helpers/db';
import {
  validateBlogData,
  countMarkdownWords,
  countBlogsToday,
  createBlog,
  updateBlog,
  listBlogs,
  parseSortParam,
  toggleLike,
  banActionMessage,
  BLOG_TITLE_MAX,
  BLOG_DESCRIPTION_MAX,
  BLOG_CONTENT_MAX,
  BLOG_DAILY_LIMIT,
} from '@/lib/blog-service';
import { nowForDb } from '@/lib/db-time';

// ── 本地栏目工厂 ─────────────────────────────────────────────────────────────
// 注：不用 helpers/db.ts 的 makeCategory —— 它当前是坏的（缺必填 slug、字段名
// adminOnly 在 schema 里叫 adminOnlyPosting），调用必抛。见交付说明。
let catSeq = 0;
function mkCat(
  opts: Partial<{
    name: string;
    slug: string;
    isActive: boolean;
    parentId: number | null;
    excludeFromAll: boolean;
    sortOrder: number;
  }> = {}
) {
  const n = ++catSeq;
  return prisma.category.create({
    data: {
      name: opts.name ?? `cat_${n}`,
      slug: opts.slug ?? `slug-${n}-${Math.random().toString(36).slice(2, 8)}`,
      isActive: opts.isActive ?? true,
      parentId: opts.parentId ?? null,
      excludeFromAll: opts.excludeFromAll ?? false,
      sortOrder: opts.sortOrder ?? 0,
      createdAt: new Date(),
    },
  });
}

/** 合法的最小提交体，便于只改一个字段做单变量测试。 */
const baseInput = (over: Record<string, unknown> = {}) => ({
  title: '标题',
  description: '摘要',
  content: '正文',
  ...over,
});

beforeEach(async () => {
  await resetDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. validateBlogData —— 文案逐字对齐 Flask BlogValidator.validate_blog_data
// ─────────────────────────────────────────────────────────────────────────────

describe('validateBlogData / 常量与 Flask 对齐', () => {
  it('长度上限常量（30 / 100 / 250000）', () => {
    // 这三个数字前端也在用（字数计数器），漂了就会出现「前端说没超、后端说超了」
    expect(BLOG_TITLE_MAX, 'MAX_TITLE_LENGTH').toBe(30);
    expect(BLOG_DESCRIPTION_MAX, 'MAX_DESCRIPTION_LENGTH').toBe(100);
    expect(BLOG_CONTENT_MAX, 'MAX_CONTENT_LENGTH').toBe(250000);
  });
});

describe('validateBlogData / 缺参数', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'not-an-object'],
    ['数字', 123],
  ])('%s → 「缺少必要参数」', async (_label, raw) => {
    const r = await validateBlogData(raw);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toBe('缺少必要参数');
  });

  it('空对象 → 先撞标题校验，报「标题不能为空」', async () => {
    // 对齐 Flask：`if not data` 只拦 falsy，{} 是 truthy 会往下走
    const r = await validateBlogData({});
    expect((r as { message: string }).message).toBe('标题不能为空');
  });
});

describe('validateBlogData / 必填', () => {
  it('标题为空 → 「标题不能为空」', async () => {
    const r = await validateBlogData(baseInput({ title: '' }));
    expect((r as { message: string }).message).toBe('标题不能为空');
  });

  it('标题仅空白 → trim 后为空 → 「标题不能为空」', async () => {
    const r = await validateBlogData(baseInput({ title: '   \n\t ' }));
    expect((r as { message: string }).message).toBe('标题不能为空');
  });

  it('描述为空 → 「描述不能为空」', async () => {
    const r = await validateBlogData(baseInput({ description: '  ' }));
    expect((r as { message: string }).message).toBe('描述不能为空');
  });

  it('内容为空 → 「内容不能为空」', async () => {
    const r = await validateBlogData(baseInput({ content: '' }));
    expect((r as { message: string }).message).toBe('内容不能为空');
  });

  it('校验顺序：标题 → 描述 → 内容（全空时只报标题）', async () => {
    const r = await validateBlogData({ title: '', description: '', content: '' });
    expect((r as { message: string }).message).toBe('标题不能为空');
  });

  it('内容仅空白 → 通过（Flask 对 content 不 trim，`data.get("content") or ""` 里 "   " 为真）', async () => {
    // 这条容易被“顺手加个 trim”改坏 —— 语义差异必须钉住
    const r = await validateBlogData(baseInput({ content: '   ' }));
    expect(r.ok, 'content 不参与 trim，纯空白应视为非空').toBe(true);
    expect((r as { data: { content: string } }).data.content).toBe('   ');
  });

  it('非字符串字段按空处理（title 传数字 → 「标题不能为空」）', async () => {
    const r = await validateBlogData(baseInput({ title: 123 }));
    expect((r as { message: string }).message).toBe('标题不能为空');
  });
});

describe('validateBlogData / 长度上限（边界逐字对齐）', () => {
  it('标题恰好 30 字 → 通过；31 字 → 「标题不能超过30个字符」', async () => {
    const ok = await validateBlogData(baseInput({ title: 'a'.repeat(30) }));
    expect(ok.ok, '恰好等于上限应放行（Flask 用 > 判断）').toBe(true);

    const bad = await validateBlogData(baseInput({ title: 'a'.repeat(31) }));
    expect((bad as { message: string }).message).toBe('标题不能超过30个字符');
  });

  it('长度按 trim 后计算（两侧空白不计入 30）', async () => {
    const r = await validateBlogData(baseInput({ title: `  ${'a'.repeat(30)}  ` }));
    expect(r.ok, 'trim 先于长度校验').toBe(true);
  });

  it('摘要恰好 100 字 → 通过；101 字 → 「描述不能超过100个字符」', async () => {
    const ok = await validateBlogData(baseInput({ description: 'b'.repeat(100) }));
    expect(ok.ok).toBe(true);

    const bad = await validateBlogData(baseInput({ description: 'b'.repeat(101) }));
    expect((bad as { message: string }).message).toBe('描述不能超过100个字符');
  });

  it('正文恰好 250000 字 → 通过；250001 字 → 「内容不能超过250000个字符」', async () => {
    const ok = await validateBlogData(baseInput({ content: 'c'.repeat(250000) }));
    expect(ok.ok).toBe(true);

    const bad = await validateBlogData(baseInput({ content: 'c'.repeat(250001) }));
    expect((bad as { message: string }).message).toBe('内容不能超过250000个字符');
  });

  it('中文按字符数而非字节数计（30 个汉字应通过）', async () => {
    const r = await validateBlogData(baseInput({ title: '汉'.repeat(30) }));
    expect(r.ok, '不能退化成 Buffer.byteLength').toBe(true);
  });
});

describe('validateBlogData / 栏目校验', () => {
  it('不传 category_id → categoryId 为 null（未分类）', async () => {
    const r = await validateBlogData(baseInput());
    expect(r.ok).toBe(true);
    expect((r as { data: { categoryId: number | null } }).data.categoryId).toBeNull();
  });

  it.each([
    ['null', null],
    ['空字符串', ''],
    ['数字 0', 0],
    ['undefined', undefined],
  ])('category_id 为 %s（falsy）→ 放行为未分类，不查库', async (_l, v) => {
    const r = await validateBlogData(baseInput({ category_id: v }));
    expect(r.ok).toBe(true);
    expect((r as { data: { categoryId: number | null } }).data.categoryId).toBeNull();
  });

  it('栏目存在且 isActive → 通过并回填 categoryId', async () => {
    const cat = await mkCat({ isActive: true });
    const r = await validateBlogData(baseInput({ category_id: cat.id }));
    expect(r.ok).toBe(true);
    expect((r as { data: { categoryId: number | null } }).data.categoryId).toBe(cat.id);
  });

  it('category_id 传字符串数字 → 也接受（对齐 Flask 的 int() 转换）', async () => {
    const cat = await mkCat({ isActive: true });
    const r = await validateBlogData(baseInput({ category_id: String(cat.id) }));
    expect(r.ok, '表单/JSON 常把 id 传成字符串').toBe(true);
    expect((r as { data: { categoryId: number | null } }).data.categoryId).toBe(cat.id);
  });

  it('栏目不存在 → 「选择的栏目不存在」', async () => {
    const r = await validateBlogData(baseInput({ category_id: 999999 }));
    expect((r as { message: string }).message).toBe('选择的栏目不存在');
  });

  it('栏目存在但已停用（isActive=false）→ 「选择的栏目不存在」', async () => {
    // Flask 的查询条件是 filter_by(id=..., is_active=True) —— 停用栏目等同不存在
    const cat = await mkCat({ isActive: false });
    const r = await validateBlogData(baseInput({ category_id: cat.id }));
    expect((r as { message: string }).message, '停用栏目不得再收新文').toBe('选择的栏目不存在');
  });

  it.each([
    ['非数字字符串', 'abc'],
    ['小数字符串', '5.7'],
    ['小数', 1.5],
    ['对象', {}],
  ])('category_id 为 %s → 「栏目ID格式错误」', async (_l, v) => {
    const r = await validateBlogData(baseInput({ category_id: v }));
    expect((r as { message: string }).message).toBe('栏目ID格式错误');
  });

  it('长度校验先于栏目校验（超长标题 + 非法栏目 → 只报标题）', async () => {
    const r = await validateBlogData(baseInput({ title: 'a'.repeat(31), category_id: 'abc' }));
    expect((r as { message: string }).message).toBe('标题不能超过30个字符');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 发文日限额 —— 对齐 upload_blog 视图：created_at >= 本站当日零点（UTC+8 墙上时间，
//    与 countBlogsToday / db-time 同一把钟），today_count >= 20 拒绝
// ─────────────────────────────────────────────────────────────────────────────

import { dayStart, todayStr } from '@/lib/db-time';

/** 今天（UTC+8 墙上日期）零点 + offsetMs 的时间点 —— 与 db-time 的 dayStart 同口径。 */
function todayAt(offsetMs: number) {
  return new Date(dayStart(todayStr()).getTime() + offsetMs);
}

const HOUR = 3600_000;

describe('发文日限额 / countBlogsToday + BLOG_DAILY_LIMIT', () => {
  it('上限常量为 20（对齐视图里的 today_count >= 20）', () => {
    expect(BLOG_DAILY_LIMIT).toBe(20);
  });

  it('无文章 → 0', async () => {
    const u = await makeUser();
    expect(await countBlogsToday(u.id)).toBe(0);
  });

  it('第 19 篇后仍放行；恰好 20 篇时应拒绝（>= 上限即拒）', async () => {
    const u = await makeUser();
    for (let i = 0; i < 19; i++) {
      await makeBlog({ authorId: u.id, createdAt: todayAt(i * 60_000) });
    }
    const n19 = await countBlogsToday(u.id);
    expect(n19).toBe(19);
    expect(n19 >= BLOG_DAILY_LIMIT, '第 20 篇必须还能发').toBe(false);

    await makeBlog({ authorId: u.id, createdAt: todayAt(20 * 60_000) });
    const n20 = await countBlogsToday(u.id);
    expect(n20).toBe(20);
    expect(n20 >= BLOG_DAILY_LIMIT, '已发满 20 篇，第 21 篇必须被拒').toBe(true);
  });

  it('边界：今天零点整计入；昨天 23:59:59.999 不计入（gte 本地零点）', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, createdAt: todayAt(0) }); // 零点整
    await makeBlog({ authorId: u.id, createdAt: todayAt(-1) }); // 昨天最后 1ms
    expect(await countBlogsToday(u.id), '零点整属于今天，前一毫秒不属于').toBe(1);
  });

  it('跨天后清零：昨天发满 20 篇，今天计数为 0', async () => {
    const u = await makeUser();
    for (let i = 0; i < 20; i++) {
      await makeBlog({ authorId: u.id, createdAt: todayAt(-24 * HOUR + i * 60_000) });
    }
    expect(await countBlogsToday(u.id), '限额按自然日重置，不是滚动 24h').toBe(0);
  });

  it('只统计本作者（他人今天的文章不占用我的额度）', async () => {
    const me = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < 5; i++) await makeBlog({ authorId: other.id, createdAt: todayAt(i) });
    await makeBlog({ authorId: me.id, createdAt: todayAt(0) });
    expect(await countBlogsToday(me.id)).toBe(1);
  });

  it('软删除的文章仍占额度（对齐 Flask：查询不过滤 ignore）', async () => {
    // 若日后加上 ignore=false 过滤，用户就能靠「发了删、删了发」绕过限额
    const u = await makeUser();
    await makeBlog({ authorId: u.id, createdAt: todayAt(0), ignore: true });
    expect(await countBlogsToday(u.id)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. countMarkdownWords —— 对齐 app/utils/markdown_countword.py
//    下列期望值均由 Python 原实现跑出来后写死，逐条比对。
// ─────────────────────────────────────────────────────────────────────────────

describe('countMarkdownWords / 与 Python 原实现逐样例对齐', () => {
  it('纯文本中英混排', () => {
    // Python 实测：{'total_characters': 16, 'non_whitespace_characters': 14}
    expect(countMarkdownWords('你好世界 hello world')).toEqual({
      total_characters: 16,
      non_whitespace_characters: 14,
    });
  });

  it('围栏代码块整段剔除（```...``` 跨行）', () => {
    const md = '正文开始\n```python\nprint(1)\n```\n正文结束';
    // 剩 "正文开始 正文结束" → 9 / 8
    expect(countMarkdownWords(md)).toEqual({
      total_characters: 9,
      non_whitespace_characters: 8,
    });
  });

  it('行内代码剔除（单行）', () => {
    // '这是 `code` 行内' → '这是 行内' → 5 / 4
    expect(countMarkdownWords('这是 `code` 行内')).toEqual({
      total_characters: 5,
      non_whitespace_characters: 4,
    });
  });

  it('图片整体剔除（alt 文字也不计）', () => {
    // '看图 ![alt](http://x.com/a.png) 完' → '看图 完' → 4 / 3
    expect(countMarkdownWords('看图 ![alt](http://x.com/a.png) 完')).toEqual({
      total_characters: 4,
      non_whitespace_characters: 3,
    });
  });

  it('链接剔除 URL 但保留链接文字', () => {
    // '点 [百度](http://baidu.com) 吧' → '点 百度 吧' → 6 / 4
    expect(countMarkdownWords('点 [百度](http://baidu.com) 吧')).toEqual({
      total_characters: 6,
      non_whitespace_characters: 4,
    });
  });

  it('HTML 标签剔除但保留标签内文字', () => {
    // '前<b>粗</b>后' → '前粗后' → 3 / 3
    expect(countMarkdownWords('前<b>粗</b>后')).toEqual({
      total_characters: 3,
      non_whitespace_characters: 3,
    });
  });

  it('综合样例：标题 + 加粗 + 代码块 + 图片 + 链接 + 中英混排', () => {
    const md = '# 标题\n\n中英 mix 文本 **加粗**\n\n```js\nlet a=1\n```\n\n![img](a.png) [链接](b.com)';
    // Python 实测：18 / 13
    expect(countMarkdownWords(md)).toEqual({
      total_characters: 18,
      non_whitespace_characters: 13,
    });
  });

  it('空字符串 → 0 / 0', () => {
    expect(countMarkdownWords('')).toEqual({
      total_characters: 0,
      non_whitespace_characters: 0,
    });
  });

  it('连续空白折叠为单空格并 trim', () => {
    // '  a \n\n\t b  ' → 'a b' → 3 / 2
    expect(countMarkdownWords('  a \n\n\t b  ')).toEqual({
      total_characters: 3,
      non_whitespace_characters: 2,
    });
  });

  it('Markdown 特殊字符 * _ ~ > # - [ ] ( ) ! 一律剔除', () => {
    expect(countMarkdownWords('*_~>#-[]()!')).toEqual({
      total_characters: 0,
      non_whitespace_characters: 0,
    });
  });

  // 【回归】跨行的行内反引号不该被整段吃掉。
  // Python 的 r'`.*?`' **未开 DOTALL** → 不跨行 → 'a `x\ny` b' 保留为 'a x y b' = 7/4。
  // 曾经 TS 写成 /`[\s\S]*?`/g（跨行）→ 整段吃掉 → 'a b' = 3/2。
  // 五条正则里只有代码块那条 Python 才开了 DOTALL，其余必须用不跨行的 `.`。
  it('跨行的行内反引号不跨行匹配（与 Python 一致：7/4）', () => {
    expect(
      countMarkdownWords('a `x\ny` b'),
      '若用 [\\s\\S] 模拟 `.`，会漏掉 Python 未开 DOTALL 这一点'
    ).toEqual({ total_characters: 7, non_whitespace_characters: 4 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. createBlog —— Blog + BlogContent 分表、同事务、UUID 主键
// ─────────────────────────────────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createBlog', () => {
  it('返回 UUID v4 主键（对齐 Flask 的 str(uuid.uuid4())）', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, {
      title: 'T',
      description: 'D',
      content: 'C',
      categoryId: null,
    });
    expect(id).toMatch(UUID_V4);
  });

  it('元信息落 blogs 表、正文落 blog_contents 表（分表写入）', async () => {
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const id = await createBlog(u.id, {
      title: '我的标题',
      description: '我的摘要',
      content: '# 正文\n\n内容',
      categoryId: cat.id,
    });

    const blog = await prisma.blog.findUnique({ where: { id } });
    expect(blog).not.toBeNull();
    expect(blog!.title).toBe('我的标题');
    expect(blog!.description).toBe('我的摘要');
    expect(blog!.authorId).toBe(u.id);
    expect(blog!.categoryId).toBe(cat.id);
    expect(blog!.createdAt).toBeInstanceOf(Date);

    const content = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(content, '正文必须分表存放，不能塞进 blogs 表').not.toBeNull();
    expect(content!.content).toBe('# 正文\n\n内容');
  });

  it('新文章的默认值：ignore=false / isFeatured=false / 各计数为 0', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    const blog = await prisma.blog.findUnique({ where: { id } });
    expect(blog!.ignore, '新文章不能是软删除态').toBe(false);
    expect(blog!.isFeatured, '精选只能由管理员后置设置').toBe(false);
    expect(blog!.likesCount).toBe(0);
    expect(blog!.commentsCount).toBe(0);
    expect(blog!.fishCount).toBe(0);
  });

  it('categoryId 为 null → 落库为未分类', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    const blog = await prisma.blog.findUnique({ where: { id } });
    expect(blog!.categoryId).toBeNull();
  });

  it('每次调用生成不同主键', async () => {
    const u = await makeUser();
    const a = await createBlog(u.id, { title: 'A', description: 'D', content: 'C', categoryId: null });
    const b = await createBlog(u.id, { title: 'B', description: 'D', content: 'C', categoryId: null });
    expect(a).not.toBe(b);
  });

  it('作者不存在 → 整体失败，不留下孤儿正文（事务原子性）', async () => {
    const before = await prisma.blogContent.count();
    await expect(
      createBlog('no-such-user', { title: 'T', description: 'D', content: 'C', categoryId: null })
    ).rejects.toThrow();
    expect(await prisma.blogContent.count(), '写 blogs 失败时 blog_contents 不能有残留').toBe(before);
    expect(await prisma.blog.count()).toBe(0);
  });

  it('刚创建的文章当天即计入日限额', async () => {
    const u = await makeUser();
    await createBlog(u.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    expect(await countBlogsToday(u.id)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. updateBlog —— 变更详情字符串逐字对齐 + hasChanges 语义
// ─────────────────────────────────────────────────────────────────────────────

describe('updateBlog / 变更详情文案', () => {
  it('标题变更 → 「标题从《旧》改为《新》」（书名号逐字对齐）', async () => {
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: '旧标题', description: 'D', content: 'C' });
    const r = await updateBlog(b.id, { title: '新标题', description: 'D', content: 'C', categoryId: null });
    expect(r.hasChanges).toBe(true);
    expect(r.changesDetail).toEqual(['标题从《旧标题》改为《新标题》']);
  });

  it('摘要变更 → 「摘要已更新」（不回显新旧内容）', async () => {
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: 'T', description: '旧摘要', content: 'C' });
    const r = await updateBlog(b.id, { title: 'T', description: '新摘要', content: 'C', categoryId: null });
    expect(r.changesDetail).toEqual(['摘要已更新']);
  });

  it('正文变更 → 「文章内容已更新」', async () => {
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: '旧正文' });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: '新正文', categoryId: null });
    expect(r.changesDetail).toEqual(['文章内容已更新']);
  });

  it('未分类 → 有栏目：「栏目从《未分类》改为《技术》」', async () => {
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', categoryId: null });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: cat.id });
    expect(r.changesDetail).toEqual(['栏目从《未分类》改为《技术》']);
  });

  it('有栏目 → 未分类：「栏目从《技术》改为《未分类》」', async () => {
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', categoryId: cat.id });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    expect(r.changesDetail, '缺省名必须是「未分类」').toEqual(['栏目从《技术》改为《未分类》']);
  });

  it('栏目 A → 栏目 B：新旧名称都取真实栏目名', async () => {
    const u = await makeUser();
    const a = await mkCat({ name: '生活' });
    const b2 = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', categoryId: a.id });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: b2.id });
    expect(r.changesDetail).toEqual(['栏目从《生活》改为《技术》']);
  });

  it('多项同时变更 → 顺序固定为 标题 / 摘要 / 栏目 / 正文', async () => {
    // 顺序即通知里的展示顺序，Flask 的 append 顺序如此，不能乱
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: '旧', description: '旧摘要', content: '旧正文', categoryId: null });
    const r = await updateBlog(b.id, { title: '新', description: '新摘要', content: '新正文', categoryId: cat.id });
    expect(r.changesDetail).toEqual([
      '标题从《旧》改为《新》',
      '摘要已更新',
      '栏目从《未分类》改为《技术》',
      '文章内容已更新',
    ]);
  });
});

describe('updateBlog / hasChanges 语义与落库', () => {
  it('提交与原值完全相同 → hasChanges=false 且 changesDetail 为空', async () => {
    // 语义要点：这是「不给作者发编辑通知」的判据 —— 误判就会骚扰用户
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', categoryId: cat.id });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: cat.id });
    expect(r.hasChanges).toBe(false);
    expect(r.changesDetail).toEqual([]);
  });

  it('未分类 → 未分类（都是 null）不算变更', async () => {
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', categoryId: null });
    const r = await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    expect(r.hasChanges, 'null === null 不应被判成栏目变化').toBe(false);
  });

  it('无变更时仍然执行写入（幂等落库，不炸）', async () => {
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C' });
    await updateBlog(b.id, { title: 'T', description: 'D', content: 'C', categoryId: null });
    const after = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(after!.title).toBe('T');
  });

  it('变更后元信息与正文都真的落库', async () => {
    const u = await makeUser();
    const cat = await mkCat({ name: '技术' });
    const b = await makeBlog({ authorId: u.id, title: '旧', description: '旧摘要', content: '旧正文' });
    await updateBlog(b.id, { title: '新', description: '新摘要', content: '新正文', categoryId: cat.id });

    const blog = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(blog!.title).toBe('新');
    expect(blog!.description).toBe('新摘要');
    expect(blog!.categoryId).toBe(cat.id);

    const content = await prisma.blogContent.findUnique({ where: { blogId: b.id } });
    expect(content!.content).toBe('新正文');
  });

  it('文章不存在 → { hasChanges: false, changesDetail: [] }（对齐 Flask 的 (False, [])）', async () => {
    const r = await updateBlog('no-such-blog', { title: 'T', description: 'D', content: 'C', categoryId: null });
    expect(r).toEqual({ hasChanges: false, changesDetail: [] });
  });

  it('正文行缺失时 upsert 创建（对齐 Flask：content_obj 不存在则 add）', async () => {
    const u = await makeUser();
    // 故意造一篇没有 blog_contents 行的文章（历史数据里存在这种情况）
    await prisma.blog.create({
      data: { id: 'orphan-blog', title: 'T', description: 'D', authorId: u.id, createdAt: new Date() },
    });
    const r = await updateBlog('orphan-blog', { title: 'T', description: 'D', content: '新正文', categoryId: null });
    expect(r.changesDetail, '旧正文视为空串，与新正文不同 → 记一条变更').toEqual(['文章内容已更新']);

    const content = await prisma.blogContent.findUnique({ where: { blogId: 'orphan-blog' } });
    expect(content!.content).toBe('新正文');
  });

  it('【与 Flask 不一致】软删除的文章仍可被 updateBlog 改（未过滤 ignore）', async () => {
    // Flask 的 update_blog 用 Blog.query.get 也不过滤 ignore，行为其实一致；
    // 但 getBlogForEdit 会过滤 —— 这里钉住 service 层不设防，权限得由调用方兜。
    const u = await makeUser();
    const b = await makeBlog({ authorId: u.id, title: 'T', description: 'D', content: 'C', ignore: true });
    const r = await updateBlog(b.id, { title: 'T2', description: 'D', content: 'C', categoryId: null });
    expect(r.hasChanges).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. listBlogs —— 软删除过滤 / 分类过滤 / 分页 / 排序
// ─────────────────────────────────────────────────────────────────────────────

describe('listBlogs / 软删除过滤', () => {
  it('ignore=true 的文章不返回也不计入 total', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '正常', ignore: false });
    await makeBlog({ authorId: u.id, title: '已删', ignore: true });

    const r = await listBlogs({});
    expect(r.blogs.map((b) => b.title), '软删除的文章绝不能出现在列表').toEqual(['正常']);
    expect(r.total, 'total 也必须排除软删除，否则分页页数会虚高').toBe(1);
  });
});

describe('listBlogs / 排序与分页', () => {
  /** 造 n 篇文章，createdAt 依次递增（b0 最早，b{n-1} 最新）。 */
  async function seed(n: number, authorId: string) {
    for (let i = 0; i < n; i++) {
      await makeBlog({ authorId, title: `b${i}`, createdAt: new Date(2026, 0, 1, 0, i) });
    }
  }

  it('默认按 createdAt 倒序（最新在前）', async () => {
    const u = await makeUser();
    await seed(3, u.id);
    const r = await listBlogs({});
    expect(r.blogs.map((b) => b.title)).toEqual(['b2', 'b1', 'b0']);
  });

  it('分页：perPage 切片 + pages/hasPrev/hasNext 正确', async () => {
    const u = await makeUser();
    await seed(5, u.id);

    const p1 = await listBlogs({ page: 1, perPage: 2 });
    expect(p1.blogs.map((b) => b.title)).toEqual(['b4', 'b3']);
    expect(p1.total).toBe(5);
    expect(p1.pages, 'ceil(5/2)=3').toBe(3);
    expect(p1.hasPrev).toBe(false);
    expect(p1.hasNext).toBe(true);

    const p2 = await listBlogs({ page: 2, perPage: 2 });
    expect(p2.blogs.map((b) => b.title)).toEqual(['b2', 'b1']);
    expect(p2.hasPrev).toBe(true);
    expect(p2.hasNext).toBe(true);

    const p3 = await listBlogs({ page: 3, perPage: 2 });
    expect(p3.blogs.map((b) => b.title), '末页只剩 1 条').toEqual(['b0']);
    expect(p3.hasPrev).toBe(true);
    expect(p3.hasNext).toBe(false);
  });

  it('超出末页 → 空列表，但 total/pages 仍是真值', async () => {
    const u = await makeUser();
    await seed(3, u.id);
    const r = await listBlogs({ page: 99, perPage: 2 });
    expect(r.blogs).toEqual([]);
    expect(r.total).toBe(3);
    expect(r.pages).toBe(2);
    expect(r.hasNext).toBe(false);
  });

  it('空结果时 pages 兜底为 1（不能是 0，否则前端分页器会崩）', async () => {
    const r = await listBlogs({});
    expect(r.total).toBe(0);
    expect(r.pages).toBe(1);
    expect(r.hasPrev).toBe(false);
    expect(r.hasNext).toBe(false);
  });

  it('page < 1 被夹到 1；perPage 夹在 [1, 200]', async () => {
    // 防「?perPage=100000 拖库」和「?page=0 负 skip 报错」
    const u = await makeUser();
    await seed(3, u.id);
    expect((await listBlogs({ page: 0 })).page).toBe(1);
    expect((await listBlogs({ page: -5 })).page).toBe(1);
    expect((await listBlogs({ perPage: 9999 })).perPage).toBe(200);
    expect((await listBlogs({ perPage: 0 })).perPage).toBe(1);
    expect((await listBlogs({})).perPage, '默认每页 200').toBe(200);
  });
});

describe('listBlogs / sort 参数（created=发布时间 / updated=最后编辑时间）', () => {
  /**
   * 造 3 篇文章，让「发布时间序」与「更新时间序」互相翻转：
   *   u0：发布最早、更新最晚（default 序排最后、updated 序排最前）
   *   u1：发布居中、更新居中
   *   u2：发布最晚、更新最早（default 序排最前、updated 序排最后）
   */
  async function seedReversed(authorId: string) {
    await makeBlog({
      authorId,
      title: 'u0',
      createdAt: new Date(2026, 0, 1, 0, 0, 0),
      contentUpdatedAt: new Date(2026, 2, 1, 0, 0, 0),
    });
    await makeBlog({
      authorId,
      title: 'u1',
      createdAt: new Date(2026, 1, 1, 0, 0, 0),
      contentUpdatedAt: new Date(2026, 1, 1, 0, 0, 0),
    });
    await makeBlog({
      authorId,
      title: 'u2',
      createdAt: new Date(2026, 2, 1, 0, 0, 0),
      contentUpdatedAt: new Date(2026, 0, 1, 0, 0, 0),
    });
  }

  it('默认（不传/created）仍按 createdAt 倒序，行为与加功能前一致', async () => {
    const u = await makeUser();
    await seedReversed(u.id);
    expect((await listBlogs({})).blogs.map((b) => b.title), '不传').toEqual(['u2', 'u1', 'u0']);
    expect((await listBlogs({ sort: 'created' })).blogs.map((b) => b.title), '显式 created').toEqual([
      'u2',
      'u1',
      'u0',
    ]);
  });

  it('sort=updated 按 BlogContent.updatedAt 倒序（可跨 created 序翻转）', async () => {
    const u = await makeUser();
    await seedReversed(u.id);
    const r = await listBlogs({ sort: 'updated' });
    expect(r.blogs.map((b) => b.title)).toEqual(['u0', 'u1', 'u2']);
  });

  it('updated 排序与分页叠加：第 2 页是第 2 段切片', async () => {
    const u = await makeUser();
    await seedReversed(u.id);
    const p2 = await listBlogs({ sort: 'updated', page: 2, perPage: 2 });
    expect(p2.blogs.map((b) => b.title)).toEqual(['u2']);
    expect(p2.total).toBe(3);
  });

  it('content 行缺失的文章在 updated 排序下排最后（SQLite DESC 的 NULL 语义，防御分支）', async () => {
    const u = await makeUser();
    await makeBlog({
      authorId: u.id,
      title: '有content',
      createdAt: new Date(2026, 0, 1),
      contentUpdatedAt: new Date(2026, 2, 1),
    });
    const missing = await makeBlog({
      authorId: u.id,
      title: '缺content',
      createdAt: new Date(2026, 1, 1),
      contentUpdatedAt: new Date(2026, 1, 1),
    });
    // 模拟异常历史数据：正文行被删 —— 不崩、排最后，而不是被 SQL 静默吞掉
    await prisma.blogContent.delete({ where: { blogId: missing.id } });

    const r = await listBlogs({ sort: 'updated' });
    expect(r.blogs.map((b) => b.title)).toEqual(['有content', '缺content']);
  });

  it('updatedAt 同秒时用 createdAt 作次键，顺序确定不 flaky', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '早发', createdAt: new Date(2026, 0, 1), contentUpdatedAt: new Date(2026, 5, 1, 12, 0, 0) });
    await makeBlog({ authorId: u.id, title: '晚发', createdAt: new Date(2026, 1, 1), contentUpdatedAt: new Date(2026, 5, 1, 12, 0, 0) });
    const r = await listBlogs({ sort: 'updated' });
    expect(r.blogs.map((b) => b.title)).toEqual(['晚发', '早发']);
  });
});

describe('parseSortParam / 非法值一律回退 created', () => {
  it('只认显式 updated', () => {
    expect(parseSortParam('updated')).toBe('updated');
  });
  it('undefined / null / 空串 / created / 任意垃圾值 → created', () => {
    expect(parseSortParam(undefined)).toBe('created');
    expect(parseSortParam(null)).toBe('created');
    expect(parseSortParam('')).toBe('created');
    expect(parseSortParam('created')).toBe('created');
    expect(parseSortParam('foo')).toBe('created');
    expect(parseSortParam('desc')).toBe('created');
    expect(parseSortParam(123)).toBe('created');
  });
});

describe('listBlogs / 分类过滤', () => {
  it('按 slug 过滤，只返回该分类的文章', async () => {
    const u = await makeUser();
    const tech = await mkCat({ name: '技术', slug: 'tech' });
    const life = await mkCat({ name: '生活', slug: 'life' });
    await makeBlog({ authorId: u.id, title: '技术文', categoryId: tech.id });
    await makeBlog({ authorId: u.id, title: '生活文', categoryId: life.id });

    const r = await listBlogs({ categorySlug: 'tech' });
    expect(r.blogs.map((b) => b.title)).toEqual(['技术文']);
    expect(r.total).toBe(1);
  });

  it('一级栏目包含其子栏目的文章（对齐 Flask 的 child_ids 展开）', async () => {
    const u = await makeUser();
    const parent = await mkCat({ name: '技术', slug: 'tech' });
    const child = await mkCat({ name: '前端', slug: 'fe', parentId: parent.id });
    await makeBlog({ authorId: u.id, title: '父栏目文', categoryId: parent.id, createdAt: new Date(2026, 0, 2) });
    await makeBlog({ authorId: u.id, title: '子栏目文', categoryId: child.id, createdAt: new Date(2026, 0, 1) });

    const r = await listBlogs({ categorySlug: 'tech' });
    expect(r.blogs.map((b) => b.title), '点父栏目要能看到子栏目的文章').toEqual(['父栏目文', '子栏目文']);
  });

  it('二级栏目只返回自己的文章（不上溯父栏目）', async () => {
    const u = await makeUser();
    const parent = await mkCat({ name: '技术', slug: 'tech' });
    const child = await mkCat({ name: '前端', slug: 'fe', parentId: parent.id });
    await makeBlog({ authorId: u.id, title: '父栏目文', categoryId: parent.id });
    await makeBlog({ authorId: u.id, title: '子栏目文', categoryId: child.id });

    const r = await listBlogs({ categorySlug: 'fe' });
    expect(r.blogs.map((b) => b.title)).toEqual(['子栏目文']);
  });

  it('slug 不存在 → 空结果（而不是退化成返回全部）', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '文章' });
    const r = await listBlogs({ categorySlug: 'no-such-slug' });
    expect(r.blogs, '拼错 slug 绝不能泄露全站文章').toEqual([]);
    expect(r.total).toBe(0);
  });

  it('分类过滤时软删除依然生效', async () => {
    const u = await makeUser();
    const tech = await mkCat({ slug: 'tech' });
    await makeBlog({ authorId: u.id, title: '正常', categoryId: tech.id });
    await makeBlog({ authorId: u.id, title: '已删', categoryId: tech.id, ignore: true });
    const r = await listBlogs({ categorySlug: 'tech' });
    expect(r.blogs.map((b) => b.title)).toEqual(['正常']);
  });

  // 【回归】停用栏目必须对外隐藏（对齐 Flask filter_by(slug=..., is_active=True)）。
  it('已停用的栏目（isActive=false）按 slug 查不到文章', async () => {
    const u = await makeUser();
    const dead = await mkCat({ slug: 'dead', isActive: false });
    await makeBlog({ authorId: u.id, title: '停用栏目下的文章', categoryId: dead.id });
    const r = await listBlogs({ categorySlug: 'dead' });
    expect(r.blogs, '停用栏目下的文章不该能通过 slug 直接访问').toEqual([]);
  });

  it('停用的子栏目不被父栏目带出来', async () => {
    const u = await makeUser();
    const parent = await mkCat({ slug: 'p' });
    const deadChild = await mkCat({ slug: 'dead-child', isActive: false, parentId: parent.id });
    const liveChild = await mkCat({ slug: 'live-child', parentId: parent.id });
    await makeBlog({ authorId: u.id, title: '停用子栏目文', categoryId: deadChild.id });
    await makeBlog({ authorId: u.id, title: '正常子栏目文', categoryId: liveChild.id });

    const r = await listBlogs({ categorySlug: 'p' });
    expect(r.blogs.map((b) => b.title)).toEqual(['正常子栏目文']);
  });
});

describe('listBlogs / 「全部文章」的 excludeFromAll 排除', () => {
  it('excludeFromAll=true 的分类，其文章不出现在全部文章', async () => {
    const u = await makeUser();
    const hidden = await mkCat({ slug: 'hidden', excludeFromAll: true });
    const normal = await mkCat({ slug: 'normal' });
    await makeBlog({ authorId: u.id, title: '隐藏分类文', categoryId: hidden.id });
    await makeBlog({ authorId: u.id, title: '正常文', categoryId: normal.id });

    const r = await listBlogs({});
    expect(r.blogs.map((b) => b.title)).toEqual(['正常文']);
  });

  it('但按 slug 直接访问该分类时仍可见', async () => {
    const u = await makeUser();
    const hidden = await mkCat({ slug: 'hidden', excludeFromAll: true });
    await makeBlog({ authorId: u.id, title: '隐藏分类文', categoryId: hidden.id });
    const r = await listBlogs({ categorySlug: 'hidden' });
    expect(r.blogs.map((b) => b.title), 'exclude_from_all 只影响「全部」聚合页').toEqual(['隐藏分类文']);
  });

  // 【回归 · 用户可见】存在排除栏目时，未分类文章必须保留。
  // 曾经只写 { notIn: [...] }，而 SQL 里 `NULL NOT IN (...)` 求值为 NULL —— 未分类文章
  // 被连坐滤掉。后果：只要站内存在任意一个 exclude_from_all 栏目，
  // **所有未分类文章就从首页消失**。Flask 显式写了 (category_id IS NULL) OR (...)。
  it('存在排除栏目时，未分类（categoryId=null）文章仍出现在全部文章', async () => {
    const u = await makeUser();
    const hidden = await mkCat({ slug: 'hidden', excludeFromAll: true });
    const normal = await mkCat({ slug: 'normal' });
    await makeBlog({ authorId: u.id, title: '未分类文', categoryId: null, createdAt: new Date(2026, 0, 3) });
    await makeBlog({ authorId: u.id, title: '正常文', categoryId: normal.id, createdAt: new Date(2026, 0, 2) });
    await makeBlog({ authorId: u.id, title: '隐藏分类文', categoryId: hidden.id, createdAt: new Date(2026, 0, 1) });

    const r = await listBlogs({});
    expect(
      r.blogs.map((b) => b.title),
      '未分类文章被 notIn 连坐滤掉 —— 首页会凭空少文章'
    ).toEqual(['未分类文', '正常文']);
  });

  // 【回归】排除必须级联到子栏目（Flask 遍历 ec.children）。
  it('excludeFromAll 的栏目，其子栏目的文章也不出现在全部文章', async () => {
    const u = await makeUser();
    const hidden = await mkCat({ slug: 'hidden', excludeFromAll: true });
    const hiddenChild = await mkCat({ slug: 'hidden-child', parentId: hidden.id });
    const normal = await mkCat({ slug: 'normal' });
    await makeBlog({ authorId: u.id, title: '子栏目文', categoryId: hiddenChild.id, createdAt: new Date(2026, 0, 2) });
    await makeBlog({ authorId: u.id, title: '正常文', categoryId: normal.id, createdAt: new Date(2026, 0, 1) });

    const r = await listBlogs({});
    expect(r.blogs.map((b) => b.title), '被排除栏目的子栏目文章漏了出来').toEqual(['正常文']);
  });

  // 【回归】排除逻辑与 featured 无关（Flask 只看有没有传 category_slug）。
  it('精选页同样排除 excludeFromAll 的栏目', async () => {
    const u = await makeUser();
    const hidden = await mkCat({ slug: 'hidden', excludeFromAll: true });
    const a = await makeBlog({ authorId: u.id, title: '隐藏栏目的精选文', categoryId: hidden.id });
    await prisma.blog.update({ where: { id: a.id }, data: { isFeatured: true } });

    const r = await listBlogs({ featured: true });
    expect(r.blogs, '精选页漏出了被排除栏目的文章').toEqual([]);
  });

  it('没有任何排除分类时，未分类文章正常出现', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '未分类文', categoryId: null });
    const r = await listBlogs({});
    expect(r.blogs.map((b) => b.title)).toEqual(['未分类文']);
  });
});

describe('listBlogs / 搜索与精选', () => {
  it('search 命中标题', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: 'Rust 入门' });
    await makeBlog({ authorId: u.id, title: 'Go 入门' });
    const r = await listBlogs({ search: 'Rust' });
    expect(r.blogs.map((b) => b.title)).toEqual(['Rust 入门']);
  });

  it('search 命中摘要', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: 'A', description: '讲的是编译器' });
    await makeBlog({ authorId: u.id, title: 'B', description: '讲的是猫' });
    const r = await listBlogs({ search: '编译器' });
    expect(r.blogs.map((b) => b.title)).toEqual(['A']);
  });

  it('search 命中作者用户名', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    await makeBlog({ authorId: alice.id, title: 'Alice 的文章' });
    await makeBlog({ authorId: bob.id, title: 'Bob 的文章' });
    const r = await listBlogs({ search: 'alice' });
    expect(r.blogs.map((b) => b.title)).toEqual(['Alice 的文章']);
  });

  it('search 为空串/纯空白 → 视为不过滤', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: 'A' });
    expect((await listBlogs({ search: '' })).total).toBe(1);
    expect((await listBlogs({ search: '   ' })).total, '纯空白不应过滤掉所有文章').toBe(1);
  });

  it('featured=true → 只返回精选', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id, title: '精选文' });
    await prisma.blog.update({ where: { id: a.id }, data: { isFeatured: true } });
    await makeBlog({ authorId: u.id, title: '普通文' });

    const r = await listBlogs({ featured: true });
    expect(r.blogs.map((b) => b.title)).toEqual(['精选文']);
  });

  // 【回归】featured=false 必须筛出「非精选」（对齐 Flask `if featured in (True, False)`）。
  // 曾经写 `if (params.featured)` → false 直接跳过，等同不传，丢掉了「只看非精选」的语义。
  it('featured=false 筛出非精选文章', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id, title: '精选文', createdAt: new Date(2026, 0, 2) });
    await prisma.blog.update({ where: { id: a.id }, data: { isFeatured: true } });
    await makeBlog({ authorId: u.id, title: '普通文', createdAt: new Date(2026, 0, 1) });

    const r = await listBlogs({ featured: false });
    expect(r.blogs.map((b) => b.title), 'featured=false 退化成了不过滤').toEqual(['普通文']);
  });

  it('featured=true 只返回精选；不传则两者都返回', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id, title: '精选文', createdAt: new Date(2026, 0, 2) });
    await prisma.blog.update({ where: { id: a.id }, data: { isFeatured: true } });
    await makeBlog({ authorId: u.id, title: '普通文', createdAt: new Date(2026, 0, 1) });

    expect((await listBlogs({ featured: true })).blogs.map((b) => b.title)).toEqual(['精选文']);
    expect((await listBlogs({})).blogs.map((b) => b.title)).toEqual(['精选文', '普通文']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. toggleLike —— 点赞/取消、likesCount 冗余同步、唯一约束
// ─────────────────────────────────────────────────────────────────────────────

type LikeOk = { liked: boolean; likesCount: number };

describe('toggleLike / 点赞与取消', () => {
  it('首次点赞 → liked=true，likesCount=1，且冗余计数同步到 blogs 表', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    const r = (await toggleLike(b.id, liker.id)) as LikeOk;
    expect(r.liked).toBe(true);
    expect(r.likesCount).toBe(1);

    const blog = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(blog!.likesCount, 'blogs.likes_count 是冗余字段，必须与 blog_likes 实时一致').toBe(1);
  });

  it('再次点赞 → 取消：liked=false，计数归 0，记录软删除而非物理删除', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    await toggleLike(b.id, liker.id);
    const r = (await toggleLike(b.id, liker.id)) as LikeOk;
    expect(r.liked).toBe(false);
    expect(r.likesCount).toBe(0);

    const row = await prisma.blogLike.findUnique({
      where: { uq_blog_like_blog_user: { blogId: b.id, userId: liker.id } },
    });
    expect(row, '取消点赞不能删行（唯一约束靠这行占位）').not.toBeNull();
    expect(row!.deleted).toBe(true);
    expect(row!.deletedAt, '取消时必须记 deletedAt').toBeInstanceOf(Date);

    const blog = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(blog!.likesCount).toBe(0);
  });

  it('第三次点赞 → 复活：liked=true，deletedAt 清空', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    await toggleLike(b.id, liker.id);
    await toggleLike(b.id, liker.id);
    const r = (await toggleLike(b.id, liker.id)) as LikeOk;
    expect(r.liked).toBe(true);
    expect(r.likesCount).toBe(1);

    const row = await prisma.blogLike.findUnique({
      where: { uq_blog_like_blog_user: { blogId: b.id, userId: liker.id } },
    });
    expect(row!.deleted).toBe(false);
    expect(row!.deletedAt, '复活时必须清掉 deletedAt').toBeNull();
  });
});

describe('toggleLike / 唯一约束语义', () => {
  it('同一用户反复点赞，blog_likes 里始终只有 1 行（不重复插入）', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    for (let i = 0; i < 6; i++) await toggleLike(b.id, liker.id);

    const rows = await prisma.blogLike.findMany({ where: { blogId: b.id, userId: liker.id } });
    expect(rows.length, '唯一约束 (blog_id, user_id) —— 复用同一行做软删除切换').toBe(1);
  });

  it('偶数次切换后回到未点赞态，计数不残留', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    for (let i = 0; i < 4; i++) await toggleLike(b.id, liker.id);
    const blog = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(blog!.likesCount, '一来一回不能把计数刷高').toBe(0);
  });

  it('多个用户各点各的 → 计数为去重后的人数', async () => {
    const author = await makeUser();
    const b = await makeBlog({ authorId: author.id });
    const u1 = await makeUser();
    const u2 = await makeUser();
    const u3 = await makeUser();

    await toggleLike(b.id, u1.id);
    await toggleLike(b.id, u2.id);
    const r = (await toggleLike(b.id, u3.id)) as LikeOk;
    expect(r.likesCount).toBe(3);

    // u2 取消 → 2
    const r2 = (await toggleLike(b.id, u2.id)) as LikeOk;
    expect(r2.likesCount).toBe(2);

    const blog = await prisma.blog.findUnique({ where: { id: b.id } });
    expect(blog!.likesCount).toBe(2);
  });

  it('计数由 blog_likes 实时统计，能自愈被写脏的冗余字段', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });
    await prisma.blog.update({ where: { id: b.id }, data: { likesCount: 999 } });

    const r = (await toggleLike(b.id, liker.id)) as LikeOk;
    expect(r.likesCount, '不是 999+1，而是重新 count()').toBe(1);
  });

  it('点赞不同文章互不干扰', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b1 = await makeBlog({ authorId: author.id });
    const b2 = await makeBlog({ authorId: author.id });

    await toggleLike(b1.id, liker.id);
    const r = (await toggleLike(b2.id, liker.id)) as LikeOk;
    expect(r.likesCount).toBe(1);
    expect((await prisma.blog.findUnique({ where: { id: b1.id } }))!.likesCount).toBe(1);
  });
});

describe('toggleLike / 目标文章不存在', () => {
  it('文章不存在 → { notFound: true }', async () => {
    const u = await makeUser();
    const r = await toggleLike('no-such-blog', u.id);
    expect(r).toEqual({ notFound: true });
  });

  it('软删除的文章不可点赞 → { notFound: true }', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id, ignore: true });
    const r = await toggleLike(b.id, liker.id);
    expect(r, 'ignore=true 对外等同不存在').toEqual({ notFound: true });
    expect(await prisma.blogLike.count(), '不能给软删除文章留下点赞记录').toBe(0);
  });
});

describe('toggleLike / 限频（100 次/时）', () => {
  it('第 101 次 → { rateLimited: true }', async () => {
    const u = await makeUser();
    const b = await makeBlog({});
    for (let i = 0; i < 100; i++) {
      const r = await toggleLike(b.id, u.id);
      expect(r, `第 ${i + 1} 次应仍在额度内`).not.toEqual({ rateLimited: true });
    }
    expect(await toggleLike(b.id, u.id), '第 101 次应被限频').toEqual({ rateLimited: true });
  });

  // 【回归】无效请求不得消耗配额。
  // 曾经 rateLimit 跑在存在性检查之前 —— 刷一个不存在的 blogId 就能把自己
  // 100 次/时的点赞额度烧光（自伤）。Flask 是先查存在性再扣限频。
  it('点不存在的文章不消耗额度', async () => {
    const u = await makeUser();
    const b = await makeBlog({});

    // 200 次无效请求（远超 100 的额度）
    for (let i = 0; i < 200; i++) {
      expect(await toggleLike('ghost-blog', u.id)).toEqual({ notFound: true });
    }

    // 额度应完好无损：对真实文章仍能正常点赞
    const r = await toggleLike(b.id, u.id);
    expect(
      r,
      '无效请求烧光了配额 —— 刷不存在的 id 就能让用户点不了赞'
    ).not.toEqual({ rateLimited: true });
  });

  it('软删除的文章同样不消耗额度', async () => {
    const u = await makeUser();
    const gone = await makeBlog({ ignore: true });
    const ok = await makeBlog({});

    for (let i = 0; i < 200; i++) {
      expect(await toggleLike(gone.id, u.id)).toEqual({ notFound: true });
    }
    expect(await toggleLike(ok.id, u.id)).not.toEqual({ rateLimited: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.5 点赞通知（对齐 Flask like_service.py:84-101）
//
// 【为什么钉这些】这段通知在 Next 移植时整段丢了：toggleLike 里根本没有
// sendNotification，BlogLike.notificationSent 也从未被读写 —— 站上 4.3 万条历史
// 「文章点赞」通知在迁移后彻底断流，而设置页的 notifyLike 开关跟着一起变成摆设。
// 断言覆盖「发/不发/不重发」三条边界。
// ─────────────────────────────────────────────────────────────────────────────

describe('toggleLike / 点赞通知', () => {
  it('首次点赞 → 作者收到一条『文章点赞』，并置 notificationSent', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id, title: '被赞的文章' });

    await toggleLike(b.id, liker.id);

    const notes = await prisma.notification.findMany({ where: { recipientId: author.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      action: '文章点赞',
      actorId: liker.id,
      objectType: 'blog',
      objectId: b.id,
      read: false,
    });
    expect(notes[0].detail).toContain('被赞的文章');

    const row = await prisma.blogLike.findUnique({
      where: { uq_blog_like_blog_user: { blogId: b.id, userId: liker.id } },
    });
    expect(row!.notificationSent).toBe(true);
  });

  it('取消后重新点赞 → 不重复发（一人对一篇文章最多一条）', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    await toggleLike(b.id, liker.id); // 点赞 → 发
    await toggleLike(b.id, liker.id); // 取消 → 不发
    await toggleLike(b.id, liker.id); // 重新点亮 → 也不再发

    expect(
      await prisma.notification.count({ where: { recipientId: author.id, action: '文章点赞' } }),
      'notificationSent 是「一人一篇只发一次」的守卫'
    ).toBe(1);
  });

  it('作者给自己点赞 → 不通知', async () => {
    const author = await makeUser();
    const b = await makeBlog({ authorId: author.id });

    await toggleLike(b.id, author.id);

    expect(await prisma.notification.count({ where: { recipientId: author.id } })).toBe(0);
  });

  it('作者关掉 notifyLike → 不发通知，但点赞照常成功', async () => {
    const author = await makeUser();
    const liker = await makeUser();
    const b = await makeBlog({ authorId: author.id });
    await prisma.user.update({ where: { id: author.id }, data: { notifyLike: false } });

    const r = (await toggleLike(b.id, liker.id)) as LikeOk;

    expect(r).toMatchObject({ liked: true, likesCount: 1 });
    expect(await prisma.notification.count({ where: { recipientId: author.id } })).toBe(0);

    // 被偏好拦下 = 用户主动不要这类通知，标记保持「已发」：日后重新打开开关
    // 也不该补发历史点赞（否则开关一开就炸出一堆陈年通知）。
    const row = await prisma.blogLike.findUnique({
      where: { uq_blog_like_blog_user: { blogId: b.id, userId: liker.id } },
    });
    expect(row!.notificationSent).toBe(true);
  });

  it('多人点赞 → 每人各发一条，互不吞并', async () => {
    const author = await makeUser();
    const b = await makeBlog({ authorId: author.id });
    const u1 = await makeUser();
    const u2 = await makeUser();

    await toggleLike(b.id, u1.id);
    await toggleLike(b.id, u2.id);

    const notes = await prisma.notification.findMany({
      where: { recipientId: author.id, action: '文章点赞' },
    });
    expect(notes.map((n) => n.actorId).sort()).toEqual([u1.id, u2.id].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 回归：时间戳存储格式与日期比较（2026-07-16 补测试时发现的最严重问题）
//
// 背景：scripts/normalize-datetimes.mjs 最初把 Flask 的空格格式时间戳转成 **TEXT ISO**。
// Prisma 能读，于是一路看着都正常；但 Prisma 做 DateTime 比较时绑定的是 INTEGER 毫秒，
// 而 SQLite 跨存储类型比较**按类型序**（INTEGER < TEXT）而非数值：
//    · gte  → 所有 TEXT 行恒真
//    · lt   → 所有 TEXT 行恒假
// 实测后果：countBlogsToday 把用户历史上全部文章都算成「今天发的」。真实库里发文最多的
// 用户有 524 篇 → 切换后立刻永久触发「今日发布已达上限(20篇)」，再也发不了文。
//
// 修复：规整脚本改为写 INTEGER（Unix 毫秒），与 Prisma 自身写入格式一致，
// 读/写/比较/排序全部正确。下面的用例守住这个不变式。
// ─────────────────────────────────────────────────────────────────────────────
describe('回归：日期比较必须按数值而非存储类型', () => {
  /** 造一篇「历史文章」，可指定 created_at 的存储形态。 */
  async function insertBlogRaw(id: string, authorId: string, createdAt: number | string) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO blogs (id, author_id, title, description, ignore, created_at)
       VALUES (?, ?, ?, 'd', 0, ?)`,
      id,
      authorId,
      `t-${id}`,
      createdAt
    );
  }

  it('规整为 INTEGER 后：去年的文章不会被算成今天发的', async () => {
    const u = await makeUser({ role: 'core' });
    const lastYear = new Date('2025-03-01T10:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) await insertBlogRaw(`int-${i}`, u.id, lastYear);

    expect(
      await countBlogsToday(u.id),
      '历史文章被算进「今日已发」→ 老用户会被永久挡在日限额外'
    ).toBe(0);
  });

  it('今天发的仍能被正确计入', async () => {
    const u = await makeUser({ role: 'core' });
    const todayNoon = new Date();
    todayNoon.setHours(12, 0, 0, 0);
    await insertBlogRaw('today-1', u.id, todayNoon.getTime());
    expect(await countBlogsToday(u.id)).toBe(1);
  });

  it('Prisma 写入 SQLite 的 DateTime 就是 INTEGER —— 规整必须与之一致', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id });
    const [row] = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT typeof(created_at) t FROM blogs LIMIT 1`
    );
    expect(
      row.t,
      'Prisma 存 INTEGER；若规整脚本产出 TEXT，两者混存会让日期比较按类型序而非数值'
    ).toBe('integer');
  });

  it('反证：TEXT 存储会让日期比较失效（这正是修复前的行为）', async () => {
    const u = await makeUser({ role: 'core' });
    // 故意插 TEXT ISO（旧版规整脚本的产物）
    await insertBlogRaw('text-old', u.id, '2025-03-01T10:00:00.000Z');

    const n = await countBlogsToday(u.id);
    expect(
      n,
      'TEXT 行因 SQLite 类型序（TEXT > INTEGER）恒满足 gte —— 去年的文章被算成今天。' +
        '此用例记录该缺陷，确保规整脚本不会退回 TEXT 格式。'
    ).toBe(1); // 1 = 被错误计入（若哪天 Prisma/SQLite 改了语义，这条会红，提醒复查
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 回归：countMarkdownWords 必须与 Python 原实现逐字节一致
//
// 下面的期望值由 **Python 原实现 app/utils/markdown_countword.py 实跑得出**（非手写）。
// 关键：Python 里**只有代码块那一条**加了 re.DOTALL，其余四条（行内代码/图片/链接/
// HTML 标签）都是裸 `.`，不跨行。曾经 TS 全用了 [\s\S]（跨行），导致跨行内容被多吞：
// 例如 'a `x\ny` b' → Python 得 7/4，全 [\s\S] 得 3/2。
// ─────────────────────────────────────────────────────────────────────────────
describe('countMarkdownWords 与 Python 原实现对拍', () => {
  const CASES: { input: string; total: number; nonWs: number }[] = [
  { input: "纯文本测试", total: 5, nonWs: 5 },
  { input: "a `x\ny` b", total: 7, nonWs: 4 },
  { input: "前```\ncode\nblock\n```后", total: 2, nonWs: 2 },
  { input: "行内 `code` 文字", total: 5, nonWs: 4 },
  { input: "![图](http://x/y.png) 图片后", total: 3, nonWs: 3 },
  { input: "[链接文本](http://x) 保留", total: 7, nonWs: 6 },
  { input: "<div>\n多行\n</div>HTML", total: 7, nonWs: 6 },
  { input: "![a\nb](c) 跨行图片", total: 9, nonWs: 7 },
  { input: "[a\nb](c) 跨行链接", total: 9, nonWs: 7 },
  { input: "混排 English 中文 **粗体** `c` [l](u) 结束", total: 21, nonWs: 16 },
  { input: "", total: 0, nonWs: 0 },
  { input: "   \n\n  ", total: 0, nonWs: 0 },
  ];

  for (const c of CASES) {
    it(`${JSON.stringify(c.input)} → ${c.total}/${c.nonWs}`, () => {
      const r = countMarkdownWords(c.input);
      expect(r.total_characters, `total_characters（Python 基准 ${c.total}）`).toBe(c.total);
      expect(
        r.non_whitespace_characters,
        `non_whitespace_characters（Python 基准 ${c.nonWs}）`
      ).toBe(c.nonWs);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. listBlogs / 专注模式过滤（focusMode 参数）
//    语义：排除 focusHidden=true 的栏目**及其子栏目**下的文章（含已停用栏目 ——
//    与 excludeFromAll 只认 active 不同，站长标记的是"栏目范畴"）；未分类（NULL）
//    文章保留；categorySlug 指向被标记栏目时列表为空。
// ─────────────────────────────────────────────────────────────────────────────

describe('listBlogs / 专注模式过滤', () => {
  async function seedFocusFixture() {
    // 被标记的根栏目 + 未标记的子栏目（子栏目靠「根被标记」自动带掉）
    const waterRoot = await makeCategory({ name: '水根', slug: 'water-root', focusHidden: true });
    const waterChild = await makeCategory({ name: '水子', slug: 'water-child', parentId: waterRoot.id });
    // 未标记的对照栏目 + 一篇未分类文章
    const normal = await makeCategory({ name: '正常', slug: 'normal' });
    const bRoot = await makeBlog({ title: '在水根', categoryId: waterRoot.id });
    const bChild = await makeBlog({ title: '在水子', categoryId: waterChild.id });
    const bNormal = await makeBlog({ title: '正常文章', categoryId: normal.id });
    const bUncat = await makeBlog({ title: '未分类文章' });
    return { waterRoot, waterChild, normal, bRoot, bChild, bNormal, bUncat };
  }

  it('focusMode=true：根与子栏目文章全滤，未标记与未分类保留', async () => {
    const { bRoot, bChild, bNormal, bUncat } = await seedFocusFixture();
    const r = await listBlogs({ focusMode: true });
    const ids = r.blogs.map((b) => b.id);
    expect(ids).not.toContain(bRoot.id);
    expect(ids).not.toContain(bChild.id);
    expect(ids).toContain(bNormal.id);
    expect(ids).toContain(bUncat.id);
    expect(r.total).toBe(2);
  });

  it('focusMode 缺省 / false：行为与旧版完全一致（回归护栏）', async () => {
    const { bRoot, bChild, bNormal, bUncat } = await seedFocusFixture();
    const def = await listBlogs({});
    const off = await listBlogs({ focusMode: false });
    expect(def.total).toBe(4);
    expect(off.total).toBe(4);
    for (const b of [bRoot, bChild, bNormal, bUncat]) {
      expect(def.blogs.map((x) => x.id)).toContain(b.id);
    }
  });

  it('categorySlug 指向被标记的根/子栏目 → 空列表；指向正常栏目不受影响', async () => {
    const { waterRoot, normal, bNormal, bRoot } = await seedFocusFixture();
    const rRoot = await listBlogs({ categorySlug: waterRoot.slug, focusMode: true });
    expect(rRoot.total).toBe(0);
    const rNormal = await listBlogs({ categorySlug: normal.slug, focusMode: true });
    expect(rNormal.blogs.map((b) => b.id)).toEqual([bNormal.id]);
    // 对照：不传 focusMode 时水根栏目照常可见
    const rOff = await listBlogs({ categorySlug: waterRoot.slug });
    expect(rOff.blogs.map((b) => b.id)).toContain(bRoot.id);
  });

  it('× 精选：focus 与 featured 叠加过滤', async () => {
    const { normal, bNormal } = await seedFocusFixture();
    const flagged = await makeCategory({ focusHidden: true });
    const bFlag = await makeBlog({ title: '水贴精选', categoryId: flagged.id });
    await prisma.blog.update({ where: { id: bNormal.id }, data: { isFeatured: true } });
    await prisma.blog.update({ where: { id: bFlag.id }, data: { isFeatured: true } });
    const r = await listBlogs({ featured: true, focusMode: true });
    expect(r.blogs.map((b) => b.id)).toEqual([bNormal.id]);
    void normal;
  });

  it('× 搜索：命中被标记栏目的词条不出现', async () => {
    const { bChild } = await seedFocusFixture();
    const normal2 = await makeCategory();
    const bHit = await makeBlog({ title: '水贴研究', categoryId: normal2.id });
    const r = await listBlogs({ search: '水贴', focusMode: true });
    const ids = r.blogs.map((b) => b.id);
    expect(ids).toContain(bHit.id);
    expect(ids).not.toContain(bChild.id);
  });

  it('被标记栏目已停用仍生效（与 excludeFromAll 的 active 限制不同）', async () => {
    const offRoot = await makeCategory({ focusHidden: true, isActive: false });
    const b = await makeBlog({ title: '停用水贴', categoryId: offRoot.id });
    const normal = await makeCategory();
    const bNormal = await makeBlog({ title: '正常', categoryId: normal.id });
    const r = await listBlogs({ focusMode: true });
    expect(r.blogs.map((x) => x.id)).not.toContain(b.id);
    expect(r.blogs.map((x) => x.id)).toContain(bNormal.id);
  });

  it('与 excludeFromAll 叠加：未分类（NULL）不丢（防 NULL NOT IN 陷阱）', async () => {
    // 同时既是"全站排除"又是"专注隐藏"的栏目 + 未分类文章
    const both = await makeCategory({ excludeFromAll: true, focusHidden: true });
    await makeBlog({ title: '双重水贴', categoryId: both.id });
    const bUncat = await makeBlog({ title: '未分类' });
    const r = await listBlogs({ focusMode: true });
    expect(r.blogs.map((x) => x.id)).toEqual([bUncat.id]);
    expect(r.total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// banActionMessage —— 禁言剩余时间必须与库内时钟同口径
//
// banUntil 由 banUser 按 nowForDb() + hours 写入（admin-user-service.ts），
// 即「UTC+8 墙上时间贴 Z」。若用真实 Date.now() 相减，剩余时间会凭空多 8 小时
// （禁言 1 小时显示「剩余约 9.0 小时」）。下面用真实 nowForDb() 构造，避免冻时钟。
// ─────────────────────────────────────────────────────────────────────────────
describe('banActionMessage —— 剩余时间与库内时钟同口径', () => {
  it('刚禁言 1 小时 → 「剩余约1.0小时」（不是 9.0）', () => {
    const banUntil = new Date(nowForDb().getTime() + 3600_000);
    expect(banActionMessage({ banUntil, banReason: '刷屏' })).toBe(
      '您已被禁言，无法执行此操作。剩余约1.0小时。原因：刷屏'
    );
  });

  it('超过 24 小时走「天」文案', () => {
    const banUntil = new Date(nowForDb().getTime() + 48 * 3600_000);
    expect(banActionMessage({ banUntil })).toContain('剩余约2.0天');
  });

  it('永久禁言（banUntil 为 null）不带剩余时间（钉住现状：双句号）', () => {
    expect(banActionMessage({ banUntil: null, banReason: '严重违规' })).toBe(
      '您已被禁言，无法执行此操作。。原因：严重违规'
    );
  });

  it('【回归】真实 Date.now() 相减会算成约 9 小时 —— 这条钉住两把钟的差', () => {
    const banUntil = new Date(nowForDb().getTime() + 3600_000);
    const wrongHours = (banUntil.getTime() - Date.now()) / 3600000;
    expect(wrongHours, '错误算法：真实 UTC 与墙上时间相差 8 小时').toBeGreaterThan(8.99);
    expect(banActionMessage({ banUntil }), '正确算法').toContain('剩余约1.0小时');
  });
});
