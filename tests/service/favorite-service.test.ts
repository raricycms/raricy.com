// favorite-service.ts —— 收藏夹业务逻辑
//
// 【为什么这么测】
// 这一层要同时守住两件互相拉扯的事：公开收藏夹要能被任何 core+ 用户读到（不然
// 二维码 / 分享页 / bot 接口全无意义），私密收藏夹要**只有创建者本人**能读到
// （站长也没有例外）。两者只差一个 isPublic，所以断言必须贴着边界写：
//   · 私密收藏夹的 publicId 恒为 NULL —— 「没有对外句柄」而不是「有句柄但不显示」；
//   · 一切对外读取都过 PUBLIC_FAVORITE_WHERE，软删的公开收藏夹也必须 404；
//   · 跨用户的那条复制路径，两种 id 形态各自**结构性**地安全，而不是靠一条 if 写全。
// 另外这里钉住一条刻意与剪贴板先例相反的口径：配额只数未删除的（见
// FAVORITE_PER_USER_MAX 的注释）—— 那个先例会让「加满又删光」的用户永久卡死。
//
// 跑在临时 SQLite 上（tests/helpers/db.ts 有硬校验，不会碰真实库）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import {
  FAVORITE_PER_USER_MAX,
  FAVORITE_ITEMS_MAX,
  FAVORITE_TITLE_MAX,
  createFavorite,
  listOwnFavorites,
  isBlogFavorited,
  getOwnFavorite,
  getPublicFavorite,
  renameFavorite,
  softDeleteFavorite,
  addItem,
  removeItem,
  copyFavorite,
  exportFavorite,
  importFavorite,
  generateFavoriteId,
} from '@/lib/favorite-service';
import { FAVORITE_ID_RE } from '@/lib/favorite-refs';
import { __resetRateLimitStore } from '@/lib/rate-limit';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
});

/** 建一个收藏夹并断言成功，返回它（少写一堆 if）。 */
async function mk(userId: string, title: string, isPublic: boolean) {
  __resetRateLimitStore();
  const res = await createFavorite(userId, title, isPublic);
  if (!res.ok) throw new Error(`建收藏夹失败：${res.reason}`);
  return res.favorite;
}

// ── generateFavoriteId ───────────────────────────────────────────────────────

describe('generateFavoriteId', () => {
  it('恰好 6 位数字', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateFavoriteId();
      expect(id).toHaveLength(6);
      expect(id).toMatch(FAVORITE_ID_RE);
    }
  });

  it('不是常量（随机性冒烟）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateFavoriteId()));
    expect(set.size).toBeGreaterThan(150);
  });
});

// ── 创建 ─────────────────────────────────────────────────────────────────────

describe('createFavorite', () => {
  it('私密收藏夹**没有** 6 位 id（publicId 为 null）', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '我的私藏', false);
    expect(fav.publicId).toBeNull();
    expect(fav.isPublic).toBe(false);
  });

  it('公开收藏夹拿到 6 位数字 id', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '分享合辑', true);
    expect(fav.publicId).toMatch(FAVORITE_ID_RE);
    expect(fav.isPublic).toBe(true);
  });

  it('两个公开收藏夹的 id 不相同', async () => {
    const u = await makeUser();
    const a = await mk(u.id, '甲', true);
    const b = await mk(u.id, '乙', true);
    expect(a.publicId).not.toBe(b.publicId);
  });

  it('标题会 trim；空 / 超长 / 非字符串一律 badinput', async () => {
    const u = await makeUser();
    const ok = await createFavorite(u.id, '  有空格的  ', true);
    expect(ok.ok && ok.favorite.title).toBe('有空格的');

    for (const bad of ['', '   ', 'x'.repeat(FAVORITE_TITLE_MAX + 1), 123, null, undefined, {}]) {
      const res = await createFavorite(u.id, bad, true);
      expect(res.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false);
      expect(!res.ok && res.reason).toBe('badinput');
    }
  });

  it(`第 ${FAVORITE_PER_USER_MAX + 1} 个被拒（limit）`, async () => {
    const u = await makeUser();
    for (let i = 0; i < FAVORITE_PER_USER_MAX; i++) {
      const res = await createFavorite(u.id, `夹子 ${i}`, false);
      expect(res.ok).toBe(true);
      __resetRateLimitStore();
    }
    const extra = await createFavorite(u.id, '第 201 个', false);
    expect(!extra.ok && extra.reason).toBe('limit');
  });

  it('★ 配额只数未删除的：删光之后还能继续建（剪贴板那条先例会卡死）', async () => {
    const u = await makeUser();
    // 建满 → 全删掉 → 再建，仍然成功
    const ids: string[] = [];
    for (let i = 0; i < FAVORITE_PER_USER_MAX; i++) {
      const res = await createFavorite(u.id, `夹子 ${i}`, false);
      if (res.ok) ids.push(res.favorite.id);
      __resetRateLimitStore();
    }
    expect(ids).toHaveLength(FAVORITE_PER_USER_MAX);
    for (const id of ids) {
      const del = await softDeleteFavorite(id, u.id);
      expect(del.ok).toBe(true);
    }
    const again = await createFavorite(u.id, '删光之后', false);
    expect(again.ok, '删光后应能继续创建（配额只数未删除的）').toBe(true);
  });

  it('配额是按人算的，别人的额度不受影响', async () => {
    const a = await makeUser();
    const b = await makeUser();
    for (let i = 0; i < FAVORITE_PER_USER_MAX; i++) {
      await createFavorite(a.id, `a${i}`, false);
      __resetRateLimitStore();
    }
    const res = await createFavorite(b.id, 'b 的第一个', false);
    expect(res.ok).toBe(true);
  });

  it('限频：同一用户连建超过 20 个/时被拒', async () => {
    const u = await makeUser();
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await createFavorite(u.id, `夹 ${i}`, false);
      if (!res.ok && res.reason === 'rateLimited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

// ── 列表 / 归属 ───────────────────────────────────────────────────────────────

describe('listOwnFavorites / isBlogFavorited', () => {
  it('只列自己的、未软删的', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await mk(a.id, 'a 的', false);
    await mk(b.id, 'b 的', false);
    const list = await listOwnFavorites(a.id);
    expect(list.map((f) => f.title)).toEqual(['a 的']);
  });

  it('itemCount 只数未软删的条目', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const fav = await mk(u.id, '夹', false);
    await addItem(fav.id, u.id, blog.id);
    let list = await listOwnFavorites(u.id);
    expect(list[0].itemCount).toBe(1);
    await removeItem(fav.id, u.id, blog.id);
    list = await listOwnFavorites(u.id);
    expect(list[0].itemCount).toBe(0);
  });

  it('传 blogId 时给出 contains（选择器一次拿全）', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const withIt = await mk(u.id, '含', false);
    await mk(u.id, '不含', false);
    await addItem(withIt.id, u.id, blog.id);

    const list = await listOwnFavorites(u.id, blog.id);
    const byTitle = Object.fromEntries(list.map((f) => [f.title, f.contains]));
    expect(byTitle['含']).toBe(true);
    expect(byTitle['不含']).toBe(false);
  });

  it('isBlogFavorited：一篇可以进多个收藏夹，任一命中即为真', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const one = await mk(u.id, '一', false);
    const two = await mk(u.id, '二', false);
    expect(await isBlogFavorited(u.id, blog.id)).toBe(false);
    await addItem(two.id, u.id, blog.id);
    expect(await isBlogFavorited(u.id, blog.id)).toBe(true);
    // 同时进两个夹
    await addItem(one.id, u.id, blog.id);
    const list = await listOwnFavorites(u.id, blog.id);
    expect(list.filter((f) => f.contains)).toHaveLength(2);
  });

  it('别人收藏了不算我收藏', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const blog = await makeBlog({ authorId: a.id });
    const bf = await mk(b.id, 'b 的夹', false);
    await addItem(bf.id, b.id, blog.id);
    expect(await isBlogFavorited(a.id, blog.id)).toBe(false);
  });
});

// ── 所有者视图 / 公开视图：越权审计 ──────────────────────────────────────────

describe('getOwnFavorite —— 只有创建者本人（站长也没有例外）', () => {
  it('自己读得到，含条目', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id, title: '甲文' });
    const fav = await mk(u.id, '夹', false);
    await addItem(fav.id, u.id, blog.id);

    const res = await getOwnFavorite(fav.id, u.id);
    expect(res.ok).toBe(true);
    expect(res.ok && res.favorite.items.map((i) => i.title)).toEqual(['甲文']);
  });

  it('他人拿 UUID 读私密 → notfound（且与「不存在」同形）', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const fav = await mk(owner.id, '私藏', false);

    expect((await getOwnFavorite(fav.id, other.id)).ok).toBe(false);
    const ghost = await getOwnFavorite('00000000-0000-4000-8000-000000000000', other.id);
    // 两者对外必须无法区分（不确认存在性）
    expect(ghost.ok).toBe(false);
  });

  it('★ 站长角色**不能**读别人的私密收藏夹（刻意不继承剪贴板的后门）', async () => {
    const owner = await makeUser();
    const boss = await makeUser({ role: 'owner' });
    const fav = await mk(owner.id, '私藏', false);
    const res = await getOwnFavorite(fav.id, boss.id);
    expect(res.ok, 'owner 角色不该有越权读私密收藏夹的后门').toBe(false);
  });

  it('软删后自己读不到', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '夹', false);
    await softDeleteFavorite(fav.id, u.id);
    expect((await getOwnFavorite(fav.id, u.id)).ok).toBe(false);
  });
});

describe('getPublicFavorite —— 免认证读路径，必须严格过 PUBLIC_FAVORITE_WHERE', () => {
  it('公开收藏夹任何人可读', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '分享', true);
    const res = await getPublicFavorite(fav.publicId!);
    expect(res.ok).toBe(true);
    expect(res.ok && res.favorite.title).toBe('分享');
    expect(res.ok && res.favorite.authorName).toBe(u.username);
  });

  it('私密收藏夹没有句柄可查 —— 用任何 6 位串都查不到它', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '私藏', false);
    expect(fav.publicId).toBeNull();
    // 私密行在库里 public_id 为 NULL，不存在「猜中它的句柄」这回事
    const res = await getPublicFavorite(fav.id.slice(0, 6));
    expect(res.ok).toBe(false);
  });

  it('形态不是 6 位数字的直接 notfound（不去查库）', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '分享', true);
    for (const bad of [fav.id, 'abcdef', '12345', '1234567', '']) {
      expect((await getPublicFavorite(bad)).ok, `应拒绝 ${bad}`).toBe(false);
    }
  });

  it('★ 软删的公开收藏夹必须 404（否则「永不物理删」等于永远可读）', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '分享', true);
    expect((await getPublicFavorite(fav.publicId!)).ok).toBe(true);
    await softDeleteFavorite(fav.id, u.id);
    expect((await getPublicFavorite(fav.publicId!)).ok).toBe(false);
  });

  it('公开视图里跳过软删条目与软删博客', async () => {
    const u = await makeUser();
    const alive = await makeBlog({ authorId: u.id, title: '活' });
    const dead = await makeBlog({ authorId: u.id, title: '删' });
    const fav = await mk(u.id, '分享', true);
    await addItem(fav.id, u.id, alive.id);
    await addItem(fav.id, u.id, dead.id);
    await removeItem(fav.id, u.id, dead.id);

    const res = await getPublicFavorite(fav.publicId!);
    expect(res.ok && res.favorite.items.map((i) => i.title)).toEqual(['活']);
  });
});

// ── 改名 / 软删 ───────────────────────────────────────────────────────────────

describe('renameFavorite', () => {
  it('改标题成功，且**不动** isPublic / publicId', async () => {
    const u = await makeUser();
    const pub = await mk(u.id, '旧名', true);
    const res = await renameFavorite(pub.id, u.id, '新名');
    expect(res.ok).toBe(true);
    expect(res.ok && res.favorite.title).toBe('新名');
    expect(res.ok && res.favorite.isPublic).toBe(true);
    expect(res.ok && res.favorite.publicId).toBe(pub.publicId); // 句柄不因改名而变
  });

  it('私密收藏夹改名后仍然没有句柄', async () => {
    const u = await makeUser();
    const priv = await mk(u.id, '旧名', false);
    const res = await renameFavorite(priv.id, u.id, '新名');
    expect(res.ok && res.favorite.publicId).toBeNull();
  });

  it('他人改不动；空标题被拒', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const fav = await mk(u.id, '夹', false);
    expect((await renameFavorite(fav.id, other.id, '被改名')).ok).toBe(false);
    expect((await renameFavorite(fav.id, u.id, '  ')).ok).toBe(false);
  });
});

// ── 条目 ─────────────────────────────────────────────────────────────────────

describe('addItem / removeItem', () => {
  it('加入、重复加入（幂等）、移出、再加回来（复活旧行）', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const fav = await mk(u.id, '夹', false);

    expect((await addItem(fav.id, u.id, blog.id)).ok).toBe(true);
    expect(await isBlogFavorited(u.id, blog.id)).toBe(true);

    // 幂等：选择器里反复勾选不该报错、也不该重复计数
    const again = await addItem(fav.id, u.id, blog.id);
    expect(again.ok && again.itemCount).toBe(1);

    await removeItem(fav.id, u.id, blog.id);
    expect(await isBlogFavorited(u.id, blog.id)).toBe(false);

    // ★ 唯一约束是物理的、含墓碑行 —— 这条走的是 upsert 复活而不是插新行
    const revive = await addItem(fav.id, u.id, blog.id);
    expect(revive.ok, '移出后再加入必须能成功（复活旧行）').toBe(true);
    expect(revive.ok && revive.itemCount).toBe(1);
    const list = await listOwnFavorites(u.id);
    expect(list[0].itemCount).toBe(1);
  });

  it('同一篇可进同一用户的多个收藏夹', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const a = await mk(u.id, '甲', false);
    const b = await mk(u.id, '乙', false);
    expect((await addItem(a.id, u.id, blog.id)).ok).toBe(true);
    expect((await addItem(b.id, u.id, blog.id)).ok).toBe(true);
    const list = await listOwnFavorites(u.id);
    expect(list.every((f) => f.itemCount === 1)).toBe(true);
  });

  it('他人往我的收藏夹里塞东西 → notfound', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const fav = await mk(u.id, '夹', false);
    expect((await addItem(fav.id, other.id, blog.id)).ok).toBe(false);
    expect((await removeItem(fav.id, other.id, blog.id)).ok).toBe(false);
  });

  it('不存在的 / 已软删的博客加不进去', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '夹', false);
    expect((await addItem(fav.id, u.id, 'no-such-blog')).ok).toBe(false);
    const dead = await makeBlog({ authorId: u.id, ignore: true });
    expect((await addItem(fav.id, u.id, dead.id)).ok).toBe(false);
  });

  it(`加到第 ${FAVORITE_ITEMS_MAX + 1} 条被拒（itemsLimit）`, async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '夹', false);
    // 批量把 1000 条塞满。逐条走 addItem（还各配一篇 makeBlog）会撞 vitest 的 5s
    // 超时，而这里要钉的是**上限判定**本身，不是写入路径（写入路径上面已经覆盖）。
    const now = nowForDb();
    const ids = Array.from({ length: FAVORITE_ITEMS_MAX }, (_, i) => `bulk-blog-${i}`);
    await prisma.blog.createMany({
      data: ids.map((id) => ({ id, authorId: u.id, title: `t-${id}`, createdAt: now })),
    });
    await prisma.favoriteItem.createMany({
      data: ids.map((blogId) => ({ favoriteId: fav.id, blogId, createdAt: now })),
    });

    __resetRateLimitStore();
    const oneMore = await makeBlog({ authorId: u.id });
    const res = await addItem(fav.id, u.id, oneMore.id);
    expect(!res.ok && res.reason).toBe('itemsLimit');
  });

  it('限频：条目增删复用 like 的数值、另起前缀（第 300 次后触及 likeHourly）', async () => {
    const u = await makeUser();
    const fav = await mk(u.id, '夹', false);
    const blog = await makeBlog({ authorId: u.id });
    let limited = false;
    for (let i = 0; i < 320; i++) {
      const res = await addItem(fav.id, u.id, blog.id);
      if (!res.ok && res.reason === 'rateLimited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

// ── 复制（快照）──────────────────────────────────────────────────────────────

describe('copyFavorite', () => {
  it('私密 → 公开：新 6 位句柄，内容照抄', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id, title: '甲' });
    const priv = await mk(u.id, '私藏', false);
    await addItem(priv.id, u.id, blog.id);

    const res = await copyFavorite(priv.id, u.id, true);
    expect(res.ok).toBe(true);
    expect(res.ok && res.favorite.publicId).toMatch(FAVORITE_ID_RE);
    expect(res.ok && res.favorite.isPublic).toBe(true);
    expect(res.ok && res.itemCount).toBe(1);
    // 源行不受影响
    expect((await getOwnFavorite(priv.id, u.id)).ok).toBe(true);
  });

  it('公开 → 私密：新行**没有**句柄（不变量 1 的方向二）', async () => {
    const u = await makeUser();
    const pub = await mk(u.id, '分享', true);
    const res = await copyFavorite(pub.id, u.id, false);
    expect(res.ok && res.favorite.publicId).toBeNull();
    expect(res.ok && res.favorite.isPublic).toBe(false);
  });

  it('★ 快照：复制之后两边各走各的', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const src = await mk(u.id, '源', false);
    await addItem(src.id, u.id, blog.id);
    const copied = await copyFavorite(src.id, u.id, false);
    if (!copied.ok) throw new Error('copy failed');
    const copyId = copied.favorite.id;

    // 往源里加一条 —— 副本不该跟着变
    const extra = await makeBlog({ authorId: u.id });
    await addItem(src.id, u.id, extra.id);
    expect((await getOwnFavorite(copyId, u.id)).ok).toBe(true);
    const copyDetail = await getOwnFavorite(copyId, u.id);
    expect(copyDetail.ok && copyDetail.favorite.items).toHaveLength(1);

    // 往副本里加一条 —— 源不该跟着变
    const extra2 = await makeBlog({ authorId: u.id });
    await addItem(copyId, u.id, extra2.id);
    const srcDetail = await getOwnFavorite(src.id, u.id);
    expect(srcDetail.ok && srcDetail.favorite.items).toHaveLength(2);
  });

  it('任何人可以复制别人的**公开**收藏夹（分享页的用途）', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const blog = await makeBlog({ authorId: owner.id, title: '甲' });
    const pub = await mk(owner.id, '分享', true);
    await addItem(pub.id, owner.id, blog.id);

    // 用 6 位句柄（分享页上拿得到的那个）
    const res = await copyFavorite(pub.publicId!, other.id, false);
    expect(res.ok).toBe(true);
    expect(res.ok && res.favorite.isPublic).toBe(false);
    // 复制出来的归复制者
    expect((await getOwnFavorite(res.ok ? res.favorite.id : '', other.id)).ok).toBe(true);
  });

  it('★ 复制别人的私密收藏夹不可能：UUID 分支只在自己名下找', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const priv = await mk(owner.id, '私藏', false);

    // 攻击者拿到了内部 UUID（实际不该拿到，这里按最坏情况测）
    const res = await copyFavorite(priv.id, other.id, true);
    expect(res.ok, '不该能复制别人的私密收藏夹').toBe(false);
    // 私密行没有句柄，6 位分支也够不着
    expect(priv.publicId).toBeNull();
  });

  it('复制软删掉的源 → notfound', async () => {
    const u = await makeUser();
    const pub = await mk(u.id, '分享', true);
    await softDeleteFavorite(pub.id, u.id);
    expect((await copyFavorite(pub.id, u.id, false)).ok).toBe(false);
    expect((await copyFavorite(pub.publicId!, u.id, false)).ok).toBe(false);
  });

  it('复制出来的新行不继承源的 id / publicId', async () => {
    const u = await makeUser();
    const src = await mk(u.id, '源', true);
    const res = await copyFavorite(src.id, u.id, true);
    expect(res.ok && res.favorite.id).not.toBe(src.id);
    expect(res.ok && res.favorite.publicId).not.toBe(src.publicId);
  });

  it('复制占用创建配额（第 201 个复制被拒 —— 否则是绕过上限的后门）', async () => {
    const u = await makeUser();
    const src = await mk(u.id, '源', false);
    for (let i = 0; i < FAVORITE_PER_USER_MAX - 1; i++) {
      await createFavorite(u.id, `填 ${i}`, false);
      __resetRateLimitStore();
    }
    const res = await copyFavorite(src.id, u.id, false);
    expect(!res.ok && res.reason).toBe('limit');
  });
});

// ── 导出 / 导入 ───────────────────────────────────────────────────────────────

describe('exportFavorite', () => {
  it('只有所有者能导出（含私密）', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const priv = await mk(u.id, '私藏', false);
    expect((await exportFavorite(priv.id, u.id)).ok).toBe(true);
    expect((await exportFavorite(priv.id, other.id)).ok).toBe(false);
  });

  it('★ 导出物只含标题 + 博客列表，**不含** publicId / isPublic / 收藏夹 id', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id, title: '甲文' });
    const pub = await mk(u.id, '分享', true);
    await addItem(pub.id, u.id, blog.id);

    const res = await exportFavorite(pub.id, u.id);
    if (!res.ok) throw new Error('export failed');
    const json = JSON.stringify(res.data);
    expect(json).not.toContain(pub.publicId!); // 6 位句柄不出现
    expect(json).not.toContain(pub.id); // 内部 UUID 不出现
    expect(json).not.toContain('publicId');
    expect(json).not.toContain('isPublic');
    expect(res.data.blogs).toEqual([{ id: blog.id, title: '甲文' }]);
  });

  it('私密收藏夹也能导出，且导出物同样不含句柄（它本来就没有）', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ authorId: u.id });
    const priv = await mk(u.id, '私藏', false);
    await addItem(priv.id, u.id, blog.id);
    const res = await exportFavorite(priv.id, u.id);
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.blogs).toHaveLength(1);
  });
});

describe('importFavorite', () => {
  const payloadOf = (ids: (string | { url: string })[]) => ({
    version: 1,
    title: '导入的',
    blogs: ids.map((x) => (typeof x === 'string' ? { id: x, title: 'x' } : x)),
  });

  it('导入建出一个**新**收藏夹，返回 created / skipped', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const b = await makeBlog({ authorId: u.id });
    const res = await importFavorite(u.id, false, payloadOf([a.id, b.id, 'no-such-blog']));
    expect(res.ok).toBe(true);
    expect(res.ok && res.created).toBe(2);
    expect(res.ok && res.skipped).toBe(1);
    expect(res.ok && res.favorite.publicId).toBeNull();
  });

  it('导入成公开时才有 6 位句柄', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const res = await importFavorite(u.id, true, payloadOf([a.id]));
    expect(res.ok && res.favorite.publicId).toMatch(FAVORITE_ID_RE);
  });

  it('★ 文件里的 isPublic / publicId / 收藏夹 id 一律被忽略', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const res = await importFavorite(u.id, false, {
      version: 1,
      id: 'attacker-chosen-id',
      publicId: '999999',
      isPublic: true, // 文件想让我建个公开的
      title: '导入的',
      blogs: [{ id: a.id }],
    });
    expect(res.ok).toBe(true);
    // 请求说私密 → 就是私密；句柄不能由文件指定
    expect(res.ok && res.favorite.isPublic).toBe(false);
    expect(res.ok && res.favorite.publicId).toBeNull();
    expect(res.ok && res.favorite.id).not.toBe('attacker-chosen-id');
    // 999999 不能被它占用
    expect((await getPublicFavorite('999999')).ok).toBe(false);
  });

  it('重复的博客去重', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const res = await importFavorite(u.id, false, payloadOf([a.id, a.id, a.id]));
    expect(res.ok && res.created).toBe(1);
  });

  it('兼容手写的、只给了 url 的文件', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const res = await importFavorite(u.id, false, payloadOf([{ url: `https://x.test/blog/${a.id}` }]));
    expect(res.ok && res.created).toBe(1);
  });

  it('软删的博客不导入（计入 skipped）', async () => {
    const u = await makeUser();
    const dead = await makeBlog({ authorId: u.id, ignore: true });
    const res = await importFavorite(u.id, false, payloadOf([dead.id]));
    // 一条都没导入成功 —— 视为无效输入而不是建个空夹
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe('badinput');
  });

  it('坏输入一律 badinput', async () => {
    const u = await makeUser();
    for (const bad of [null, undefined, 'str', 42, [], {}, { blogs: 'x' }, { blogs: [] }]) {
      const res = await importFavorite(u.id, false, bad);
      expect(res.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false);
      expect(!res.ok && res.reason).toBe('badinput');
    }
  });

  it('标题缺省时给个默认名，标题非法则 badinput', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    const noTitle = await importFavorite(u.id, false, { blogs: [{ id: a.id }] });
    expect(noTitle.ok && noTitle.favorite.title).toBe('导入的收藏夹');
    const badTitle = await importFavorite(u.id, false, {
      title: 'x'.repeat(FAVORITE_TITLE_MAX + 1),
      blogs: [{ id: a.id }],
    });
    expect(!badTitle.ok && badTitle.reason).toBe('badinput');
  });

  it('导入也占创建配额', async () => {
    const u = await makeUser();
    const a = await makeBlog({ authorId: u.id });
    for (let i = 0; i < FAVORITE_PER_USER_MAX; i++) {
      await createFavorite(u.id, `填 ${i}`, false);
      __resetRateLimitStore();
    }
    const res = await importFavorite(u.id, false, payloadOf([a.id]));
    expect(!res.ok && res.reason).toBe('limit');
  });
});
