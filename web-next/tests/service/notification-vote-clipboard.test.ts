// notification / vote / clipboard 三个 service 的真实 SQLite 用例
// （对齐 Flask app/service/notifications.py、app/web/vote/、app/web/clipboard/）
//
// 【为什么把这三个放一起测】它们是本次迁移里「规则写在服务层、错了不报错只静默」
// 的三块重灾区，各自有一条不能出错的核心语义：
//
//   1. notification：发送前必须查接收者的 notify_* 偏好（force 除外）。
//      这条写漏了不会抛异常 —— 只会让关了通知的用户继续被打扰，或者反过来，
//      映射写错让该发的通知被静默吞掉。Flask 侧这条判定是散在各调用点的
//      （like_service 查 author.notify_like…），TS 侧收敛进了 prefForAction，
//      收敛就意味着「action 字符串 → 偏好字段」的映射本身成了新的失败点。
//   2. vote：每人一票靠 VoteRecord 的唯一约束 (vote_id, user_id) 兜底。
//      先查后插的检查在并发下必然漏，唯一约束 + P2002 捕获才是真正的防线。
//      另外 vote_count 是冗余计数，和 VoteRecord 行数对不上就是显示错票数。
//   3. clipboard：软删除（ignore）+ 私有可见性（publicity）两条过滤叠在一起，
//      任何一条漏了都是数据泄漏 —— 别人的私有剪贴板被读出来。
//
// 跑真实 SQLite（tests/.tmp/test.db），不 mock Prisma —— 唯一约束、并发冲突、
// 计数正是要验的东西，mock 掉等于什么都没测。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import type { SafeUser } from '@/lib/auth';
import {
  sendNotification,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  batchMarkRead,
  batchDelete,
  prefForAction,
} from '@/lib/notification-service';
import { POST as batchMarkReadPost } from '@/app/api/notifications/batch-mark-read/route';
import { DELETE as batchDeleteDelete } from '@/app/api/notifications/batch-delete/route';
import {
  generateVoteId,
  createVote,
  castVote,
  listVotes,
  getVoteDetail,
  MAX_VOTES_PER_USER,
} from '@/lib/vote-service';
import {
  createClip,
  updateClip,
  getClip,
  listUserClips,
  CLIP_TITLE_MAX,
  CLIP_CONTENT_MAX,
  CLIP_PER_USER_MAX,
} from '@/lib/clipboard-service';
import { PUT as clipPut } from '@/app/api/clipboard/[id]/route';
import { POST as clipPost } from '@/app/api/clipboard/route';
import { POST as votesPost } from '@/app/api/votes/route';

// 最后一组用例要打到 API route 才能验错误文案，于是把 getCurrentUser 换成一个
// 读可变量的桩。注意必须用**顶层 vi.mock 一次**，不能在用例里 doMock + resetModules ——
// resetModules 会让 route 重新 import 出**第二个** PrismaClient 连同一个 SQLite 文件，
// 直接把库锁成 readonly（踩过了）。这里只 mock auth，@/lib/db 始终是同一个单例。
let mockCurrentUser: SafeUser | null = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockCurrentUser };
});

beforeEach(async () => {
  await resetDb();
  mockCurrentUser = null;
});

// ── 本地工具 ────────────────────────────────────────────────────────────────

/** makeUser 不支持 notify_* 字段，这里补一个带偏好的造人工具。 */
async function makeUserWithPrefs(prefs: {
  notifyLike?: boolean;
  notifyEdit?: boolean;
  notifyDelete?: boolean;
  notifyAdmin?: boolean;
}) {
  const u = await makeUser();
  return prisma.user.update({ where: { id: u.id }, data: prefs });
}

/**
 * 直接落库造通知：sendNotification 用 new Date() 打点，毫秒级连发会撞车，
 * 而排序/分页断言必须要有确定的 timestamp，所以这类用例一律显式造。
 * 库里时间戳是 INTEGER 毫秒，用 new Date(iso).getTime() 的语义造历史数据。
 */
async function makeNotification(opts: {
  recipientId: string;
  action?: string;
  actorId?: string | null;
  read?: boolean;
  /** ISO 字符串，落库前转毫秒 */
  at?: string;
}) {
  return prisma.notification.create({
    data: {
      id: crypto.randomUUID(),
      recipientId: opts.recipientId,
      action: opts.action ?? '测试',
      actorId: opts.actorId ?? null,
      read: opts.read ?? false,
      timestamp: new Date(new Date(opts.at ?? '2026-01-01T00:00:00.000Z').getTime()),
    },
  });
}

/** batch 端点的请求体构造。URL 无所谓，handler 只读 body。 */
function jsonReq(body: unknown) {
  return new Request('http://x/api/notifications/batch', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** 造一个带 N 个选项的投票（绕开 createVote 的限频，用于纯投票行为的用例）。 */
async function makeVote(opts: {
  authorId: string;
  labels?: string[];
  isLocked?: boolean;
  ignore?: boolean;
  id?: string;
}) {
  const id = opts.id ?? generateVoteId(9);
  await prisma.vote.create({
    data: {
      id,
      title: 't',
      authorId: opts.authorId,
      isLocked: opts.isLocked ?? false,
      ignore: opts.ignore ?? false,
      createdAt: new Date(),
      options: {
        create: (opts.labels ?? ['A', 'B']).map((label, i) => ({
          label,
          sortOrder: i,
          voteCount: 0,
        })),
      },
    },
  });
  const options = await prisma.voteOption.findMany({
    where: { voteId: id },
    orderBy: { sortOrder: 'asc' },
  });
  return { id, options };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. notification-service
// ════════════════════════════════════════════════════════════════════════════

describe('notification-service', () => {
  // ── 通知偏好：本组最重要的语义 ──────────────────────────────────────────
  //
  // CLAUDE.md：「发送前检查用户通知偏好，除非 force=True」。
  // 关掉某类偏好后，对应类型的通知**必须不落库** —— 不是标记已读、不是过滤，
  // 是根本不创建。这条挂了用户就会收到自己明确关掉的推送。
  describe('通知偏好拦截', () => {
    // action → 偏好字段的映射是收敛进 prefForAction 的，先把映射本身钉死，
    // 后面的拦截用例才知道自己用的 action 落在哪个偏好上。
    it('prefForAction 把真实在用的 action 映射到对应偏好字段', () => {
      // 下面这些 action 字符串取自真实库 + TS 侧真实调用点，不是编的
      expect(prefForAction('文章点赞')).toBe('notifyLike');
      expect(prefForAction('文章编辑')).toBe('notifyEdit'); // api/blogs/[id]/route.ts
      expect(prefForAction('文章删除')).toBe('notifyDelete');
      expect(prefForAction('图片删除')).toBe('notifyDelete'); // api/images/admin/[id]/route.ts
      expect(prefForAction('禁言通知')).toBe('notifyAdmin'); // admin-user-service.ts
      expect(prefForAction('解除禁言')).toBe('notifyAdmin'); // admin-user-service.ts
      expect(prefForAction('系统公告')).toBe('notifyAdmin');
      expect(prefForAction('功能更新')).toBe('notifyAdmin');
      expect(prefForAction('申诉提交')).toBe('notifyAdmin');
    });

    it('不受偏好约束的 action 返回 null（评论 / 投喂类通知无对应偏好字段）', () => {
      // 四个开关只有 like/edit/delete/admin，没有 notify_comment、notify_feed，
      // 这类通知一律发 —— 这是有意的，不是漏
      expect(prefForAction('评论回复')).toBeNull();
      expect(prefForAction('文章评论')).toBeNull();
      expect(prefForAction('文章投喂')).toBeNull();
    });

    // ── 回归 1：精确映射表取代子串嗅探 ────────────────────────────────────
    //
    // 旧实现按「like → edit → delete → admin」顺序找第一个子串命中，导致自由文本
    // action 串到错误的偏好上。改成精确表后，下面这些「像但不是」的串一律不命中。
    it('【回归】自由文本 action 不再被子串嗅探串到错误偏好', () => {
      // 这条是本次修复的核心：管理员自由输入的 action 里带「删除」二字，
      // 旧实现 → notifyDelete（把管理员通知吞给了 delete 偏好），现在 → null
      expect(prefForAction('管理员删除通知')).toBeNull();
      // AdminUserActions.tsx 下拉里的其它自由选项，同样不再被「通知」二字吸进 notifyAdmin
      expect(prefForAction('维护通知')).toBeNull();
      expect(prefForAction('活动通知')).toBeNull();
      expect(prefForAction('警告通知')).toBeNull();
      // 英文关键字曾经命中（a.includes('like') 等），精确表下不再有这类隐式命中
      expect(prefForAction('like')).toBeNull();
      expect(prefForAction('blog_deleted')).toBeNull();
      expect(prefForAction('ADMIN_NOTICE')).toBeNull();
      // 未知 action 一律 null = 照发，绝不静默吞掉
      expect(prefForAction('')).toBeNull();
      expect(prefForAction('随便什么没见过的动作')).toBeNull();
    });

    it('【回归】原型链上的 key 不会被当成偏好命中', async () => {
      // action 是自由文本，查表若用裸下标，'constructor' 会摸到
      // Object.prototype.constructor（函数，truthy）→ 返回个非法偏好键。
      for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        expect(prefForAction(evil), evil).toBeNull();
      }
      // 且这类 action 能正常发出去，不会在偏好判定里炸掉
      const u = await makeUserWithPrefs({ notifyAdmin: false, notifyDelete: false });
      expect(await sendNotification({ recipientId: u.id, action: 'constructor' })).not.toBeNull();
    });

    it('【回归】notifyDelete=false 不再吞掉带「删除」二字的管理员通知', async () => {
      // 旧行为：prefForAction('管理员删除通知') === 'notifyDelete' → 被拦 → null。
      // 用户明明开着「管理员通知」，通知却被 delete 偏好吃了。
      const u = await makeUserWithPrefs({ notifyDelete: false, notifyAdmin: true });
      const r = await sendNotification({ recipientId: u.id, action: '管理员删除通知' });
      expect(r).not.toBeNull();
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(1);
    });

    it('【回归】prefKey 显式传入时优先于查表，且 null 表示不受偏好拦截', async () => {
      // 自由文本 action 的调用方（/api/admin/notify-user）靠这个显式声明归属，不再靠猜
      const off = await makeUserWithPrefs({ notifyAdmin: false });
      expect(
        await sendNotification({ recipientId: off.id, action: '维护通知', prefKey: 'notifyAdmin' })
      ).toBeNull();

      const on = await makeUserWithPrefs({ notifyAdmin: true, notifyLike: false });
      // 显式 prefKey 压过查表结果：action 查表本会命中 notifyLike（已关），
      // 但显式声明为 notifyAdmin（开着）→ 照发
      expect(
        await sendNotification({ recipientId: on.id, action: '文章点赞', prefKey: 'notifyAdmin' })
      ).not.toBeNull();

      // prefKey:null = 显式声明「不受任何偏好拦截」，即便查表会命中已关的偏好
      const allOff = await makeUserWithPrefs({ notifyLike: false });
      expect(
        await sendNotification({ recipientId: allOff.id, action: '文章点赞', prefKey: null })
      ).not.toBeNull();
    });

    it('notifyLike=false 时点赞通知不创建', async () => {
      const u = await makeUserWithPrefs({ notifyLike: false });
      const r = await sendNotification({ recipientId: u.id, action: '文章点赞' });
      expect(r).toBeNull();
      // 关键：是「没落库」，不是「落了库但标记了什么」
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
    });

    it('notifyEdit=false 时编辑通知不创建，但其它类型照发', async () => {
      const u = await makeUserWithPrefs({ notifyEdit: false });
      expect(await sendNotification({ recipientId: u.id, action: '文章编辑' })).toBeNull();
      // 只关了 edit，别的偏好不应被连坐 —— 这是「一刀切关掉」这类 bug 的探针
      expect(await sendNotification({ recipientId: u.id, action: '文章点赞' })).not.toBeNull();
      expect(await sendNotification({ recipientId: u.id, action: '图片删除' })).not.toBeNull();
      expect(await sendNotification({ recipientId: u.id, action: '系统公告' })).not.toBeNull();
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(3);
    });

    it('notifyDelete=false 时删除通知不创建', async () => {
      const u = await makeUserWithPrefs({ notifyDelete: false });
      expect(await sendNotification({ recipientId: u.id, action: '图片删除' })).toBeNull();
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
    });

    it('notifyAdmin=false 时管理员类通知不创建', async () => {
      const u = await makeUserWithPrefs({ notifyAdmin: false });
      expect(await sendNotification({ recipientId: u.id, action: '禁言通知' })).toBeNull();
      expect(await sendNotification({ recipientId: u.id, action: '系统公告' })).toBeNull();
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(0);
    });

    it('force:true 无视一切偏好照发（broadcast-service 依赖这条）', async () => {
      const u = await makeUserWithPrefs({
        notifyLike: false,
        notifyEdit: false,
        notifyDelete: false,
        notifyAdmin: false,
      });
      for (const action of ['文章点赞', '文章编辑', '图片删除', '系统公告']) {
        const r = await sendNotification({ recipientId: u.id, action, force: true });
        expect(r).not.toBeNull();
      }
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(4);
    });

    it('偏好为 NULL（历史数据无默认值）视为开启，不拦截', async () => {
      // 老库里 notify_* 可能是 NULL；服务里判的是 === false，
      // 这条钉住「NULL 不等于关闭」，防止有人改成 !recipient[key] 而误伤存量用户
      const u = await makeUser();
      await prisma.user.update({ where: { id: u.id }, data: { notifyLike: null } });
      expect(await sendNotification({ recipientId: u.id, action: '文章点赞' })).not.toBeNull();
    });

    it('未设置偏好的新用户默认全部开启', async () => {
      const u = await makeUser();
      for (const action of ['文章点赞', '文章编辑', '图片删除', '系统公告']) {
        expect(await sendNotification({ recipientId: u.id, action })).not.toBeNull();
      }
      expect(await prisma.notification.count({ where: { recipientId: u.id } })).toBe(4);
    });

    // ── 回归 2：两类曾经逃过全部偏好的通知，现已归入 notifyAdmin ──────────
    //
    // 「栏目发文提醒」「申诉结果」都不含任何关键字 → 旧实现返回 null → 关了
    // notifyAdmin 也照发。两者都是管理类通知，现在按精确表归 notifyAdmin。
    it('【回归】「栏目发文提醒」归入 notifyAdmin，关掉后不再照发', async () => {
      // api/blogs/route.ts 给管理员发的栏目提醒（发给管理员 = 管理类通知）
      expect(prefForAction('栏目发文提醒')).toBe('notifyAdmin');

      const off = await makeUserWithPrefs({ notifyAdmin: false });
      expect(await sendNotification({ recipientId: off.id, action: '栏目发文提醒' })).toBeNull();
      expect(await prisma.notification.count({ where: { recipientId: off.id } })).toBe(0);

      // 开着的人照收
      const on = await makeUserWithPrefs({ notifyAdmin: true });
      expect(await sendNotification({ recipientId: on.id, action: '栏目发文提醒' })).not.toBeNull();
    });

    it('【回归】「申诉结果」归入 notifyAdmin（但真实调用点仍传 force:true）', async () => {
      expect(prefForAction('申诉结果')).toBe('notifyAdmin');

      const off = await makeUserWithPrefs({ notifyAdmin: false });
      expect(await sendNotification({ recipientId: off.id, action: '申诉结果' })).toBeNull();

      // 注意：admin-appeal-service.ts 的真实调用点带 force:true，所以线上申诉结果
      // 仍然无条件送达 —— 映射只对不传 force 的调用方生效。这条钉住这个事实，
      // 免得有人以为「归了 notifyAdmin」就等于「申诉结果可被用户关掉」。
      expect(
        await sendNotification({ recipientId: off.id, action: '申诉结果', force: true })
      ).not.toBeNull();
    });
  });

  // ── 接收者不存在 ──────────────────────────────────────────────────────
  describe('接收者不存在', () => {
    it('返回 null 且不落库（不抛外键错）', async () => {
      // recipient_id 有外键约束，硬插会抛；服务必须先查用户挡掉。
      // 对齐 Flask：`if not recipient: return`
      const r = await sendNotification({ recipientId: 'no-such-user', action: '系统公告' });
      expect(r).toBeNull();
      expect(await prisma.notification.count()).toBe(0);
    });

    it('force:true 也挡得住不存在的接收者', async () => {
      // force 只应绕过偏好，不应绕过存在性检查 —— 否则直接外键报错
      const r = await sendNotification({
        recipientId: 'no-such-user',
        action: '系统公告',
        force: true,
      });
      expect(r).toBeNull();
      expect(await prisma.notification.count()).toBe(0);
    });
  });

  // ── 字段落库 ──────────────────────────────────────────────────────────
  it('创建的通知带上 actor / object / detail，且默认未读', async () => {
    const actor = await makeUser();
    const recip = await makeUser();
    const n = await sendNotification({
      recipientId: recip.id,
      action: '文章点赞',
      actorId: actor.id,
      objectType: 'blog',
      objectId: 'b1',
      detail: 'hi',
    });
    expect(n).not.toBeNull();
    expect(n!.read).toBe(false);
    expect(n!.actorId).toBe(actor.id);
    expect(n!.objectType).toBe('blog');
    expect(n!.objectId).toBe('b1');
    expect(n!.detail).toBe('hi');
    expect(n!.timestamp).toBeInstanceOf(Date);
  });

  // ── 已读 / 未读 ────────────────────────────────────────────────────────
  describe('已读 / 未读', () => {
    it('getUnreadCount 只数未读且只数自己的', async () => {
      const me = await makeUser();
      const other = await makeUser();
      await makeNotification({ recipientId: me.id, read: false });
      await makeNotification({ recipientId: me.id, read: false });
      await makeNotification({ recipientId: me.id, read: true });
      await makeNotification({ recipientId: other.id, read: false }); // 别人的不该被算进来
      expect(await getUnreadCount(me.id)).toBe(2);
      expect(await getUnreadCount(other.id)).toBe(1);
    });

    it('markRead 标记本人通知成功', async () => {
      const me = await makeUser();
      const n = await makeNotification({ recipientId: me.id });
      expect(await markRead(n.id, me.id)).toBe(true);
      const after = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(after!.read).toBe(true);
    });

    it('markRead 不能标记别人的通知（越权探针）', async () => {
      // updateMany 的 where 里必须同时带 recipientId，否则拿到 id 就能改别人的
      const me = await makeUser();
      const other = await makeUser();
      const n = await makeNotification({ recipientId: other.id });
      expect(await markRead(n.id, me.id)).toBe(false);
      const after = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(after!.read).toBe(false); // 关键：别人的通知没被改
    });

    it('markRead 通知不存在时返回 false', async () => {
      const me = await makeUser();
      expect(await markRead('no-such-id', me.id)).toBe(false);
    });

    it('markRead 对已读通知重复调用仍返回 true（幂等，updateMany 命中即算）', async () => {
      const me = await makeUser();
      const n = await makeNotification({ recipientId: me.id, read: true });
      expect(await markRead(n.id, me.id)).toBe(true);
    });

    it('markAllRead 批量标记，返回本次真正标记的条数', async () => {
      const me = await makeUser();
      const other = await makeUser();
      await makeNotification({ recipientId: me.id, read: false });
      await makeNotification({ recipientId: me.id, read: false });
      await makeNotification({ recipientId: me.id, read: true }); // 已读的不该重复计数
      await makeNotification({ recipientId: other.id, read: false });

      expect(await markAllRead(me.id)).toBe(2);
      expect(await getUnreadCount(me.id)).toBe(0);
      // 关键：不能把别人的一起标了
      expect(await getUnreadCount(other.id)).toBe(1);
    });

    it('markAllRead 没有未读时返回 0', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id, read: true });
      expect(await markAllRead(me.id)).toBe(0);
    });
  });

  // ── 回归 3：批量已读 / 批量删除（补 Flask 的 batch 端点缺口）──────────────
  //
  // Flask 有 /api/batch-mark-read(POST) 与 /api/batch-delete(DELETE)，TS 侧原先没有。
  // 这两个端点最要命的是**越权**：入参是一串 id，只要漏掉 recipient 过滤，
  // 任何人都能标记 / 删除别人的通知。下面每组都带一条越权探针。
  describe('批量已读 / 批量删除（service 层）', () => {
    it('batchMarkRead 标记本人的多条，返回命中条数', async () => {
      const me = await makeUser();
      const a = await makeNotification({ recipientId: me.id });
      const b = await makeNotification({ recipientId: me.id });
      const c = await makeNotification({ recipientId: me.id }); // 不在列表里

      expect(await batchMarkRead([a.id, b.id], me.id)).toBe(2);
      expect(await prisma.notification.count({ where: { recipientId: me.id, read: true } })).toBe(2);
      // 没点名的那条不受影响
      expect((await prisma.notification.findUnique({ where: { id: c.id } }))!.read).toBe(false);
    });

    it('batchMarkRead 不能标记别人的通知（越权探针）', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const mine = await makeNotification({ recipientId: me.id });
      const theirs = await makeNotification({ recipientId: other.id });

      // 把别人的 id 混进自己的批量请求里 —— 只应命中自己那条
      expect(await batchMarkRead([mine.id, theirs.id], me.id)).toBe(1);
      // 别人的通知一个字都没动
      expect((await prisma.notification.findUnique({ where: { id: theirs.id } }))!.read).toBe(false);
    });

    it('batchMarkRead 已读条目也计入 count（对齐 Flask：过滤不带 read=False）', async () => {
      // Flask batch_mark_notifications_read 的 query 只有 id.in_() + recipient_id，
      // update() 返回的是**匹配数**而非「本次真正翻转数」。这条钉住这个语义差别，
      // 免得有人想当然加上 read:false 过滤把 count 改小。
      const me = await makeUser();
      const a = await makeNotification({ recipientId: me.id, read: true });
      const b = await makeNotification({ recipientId: me.id, read: false });
      expect(await batchMarkRead([a.id, b.id], me.id)).toBe(2);
    });

    it('batchMarkRead 空数组 / 全是不存在的 id → 0，且不误伤', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id });
      expect(await batchMarkRead([], me.id)).toBe(0);
      expect(await batchMarkRead(['no-such-id'], me.id)).toBe(0);
      // 空数组绝不能被当成「匹配全部」而把整个收件箱标已读
      expect(await prisma.notification.count({ where: { recipientId: me.id, read: true } })).toBe(0);
    });

    it('batchDelete 删除本人的多条，返回删除条数（硬删除）', async () => {
      const me = await makeUser();
      const a = await makeNotification({ recipientId: me.id });
      const b = await makeNotification({ recipientId: me.id });
      const c = await makeNotification({ recipientId: me.id });

      expect(await batchDelete([a.id, b.id], me.id)).toBe(2);
      // 硬删除：是真没了，不是软删标记
      expect(await prisma.notification.count({ where: { recipientId: me.id } })).toBe(1);
      expect(await prisma.notification.findUnique({ where: { id: c.id } })).not.toBeNull();
    });

    it('batchDelete 不能删别人的通知（越权探针）', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const mine = await makeNotification({ recipientId: me.id });
      const theirs = await makeNotification({ recipientId: other.id });

      expect(await batchDelete([mine.id, theirs.id], me.id)).toBe(1);
      // 别人的通知还在
      expect(await prisma.notification.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    });

    it('batchDelete 空数组不删任何东西（不能被当成「匹配全部」）', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id });
      expect(await batchDelete([], me.id)).toBe(0);
      expect(await prisma.notification.count({ where: { recipientId: me.id } })).toBe(1);
    });
  });

  // ── batch 端点的入参校验 / 权限 / 文案（API route 层）──────────────────
  describe('批量端点（API route 层）', () => {
    /** 两个 batch 端点入参一致，校验分支也一致，这里参数化跑。 */
    const endpoints = [
      { name: 'batch-mark-read', call: (body: unknown) => batchMarkReadPost(jsonReq(body)) },
      { name: 'batch-delete', call: (body: unknown) => batchDeleteDelete(jsonReq(body)) },
    ];

    for (const ep of endpoints) {
      it(`${ep.name} 未登录 → 401`, async () => {
        mockCurrentUser = null;
        const res = await ep.call({ notification_ids: [] });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: 401, message: '请先登录' });
      });

      it(`${ep.name} 缺 notification_ids → 400「缺少必要的参数」`, async () => {
        mockCurrentUser = (await makeUser()) as SafeUser;
        const res = await ep.call({});
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 400, message: '缺少必要的参数' });
      });

      it(`${ep.name} notification_ids 非数组 → 400「通知ID必须是数组」`, async () => {
        mockCurrentUser = (await makeUser()) as SafeUser;
        const res = await ep.call({ notification_ids: 'not-an-array' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 400, message: '通知ID必须是数组' });
      });
    }

    it('batch-mark-read 正常路径：只标自己的，count 与文案对得上（越权探针）', async () => {
      const me = await makeUser();
      const other = await makeUser();
      mockCurrentUser = me as SafeUser;
      const mine = await makeNotification({ recipientId: me.id });
      const theirs = await makeNotification({ recipientId: other.id });

      const res = await batchMarkReadPost(jsonReq({ notification_ids: [mine.id, theirs.id] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        code: 200,
        count: 1,
        message: '已标记 1 个通知为已读',
      });
      // 打到 route 也一样越不了权
      expect((await prisma.notification.findUnique({ where: { id: theirs.id } }))!.read).toBe(false);
    });

    it('batch-delete 正常路径：只删自己的，count 与文案对得上（越权探针）', async () => {
      const me = await makeUser();
      const other = await makeUser();
      mockCurrentUser = me as SafeUser;
      const mine = await makeNotification({ recipientId: me.id });
      const theirs = await makeNotification({ recipientId: other.id });

      const res = await batchDeleteDelete(jsonReq({ notification_ids: [mine.id, theirs.id] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ code: 200, count: 1, message: '已删除 1 个通知' });
      expect(await prisma.notification.findUnique({ where: { id: theirs.id } })).not.toBeNull();
      expect(await prisma.notification.findUnique({ where: { id: mine.id } })).toBeNull();
    });

    it('数组里混入非字符串项不会 500（Prisma 类型不符会直接抛）', async () => {
      const me = await makeUser();
      mockCurrentUser = me as SafeUser;
      const mine = await makeNotification({ recipientId: me.id });

      const res = await batchMarkReadPost(
        jsonReq({ notification_ids: [mine.id, 123, null, { x: 1 }] })
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ count: 1 });
    });
  });

  // ── 列表：分页 + 倒序 ──────────────────────────────────────────────────
  describe('列表分页与倒序', () => {
    it('按 timestamp 倒序（最新在前）', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id, action: '旧', at: '2026-01-01T00:00:00.000Z' });
      await makeNotification({ recipientId: me.id, action: '新', at: '2026-03-01T00:00:00.000Z' });
      await makeNotification({ recipientId: me.id, action: '中', at: '2026-02-01T00:00:00.000Z' });

      const { notifications } = await listNotifications(me.id);
      expect(notifications.map((n) => n.action)).toEqual(['新', '中', '旧']);
    });

    it('分页切片与 total / pages / hasPrev / hasNext 一致', async () => {
      const me = await makeUser();
      for (let i = 0; i < 25; i++) {
        await makeNotification({
          recipientId: me.id,
          action: `n${i}`,
          // i 越大越新 → 倒序后 n24 在最前
          at: new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + i * 60_000).toISOString(),
        });
      }

      const p1 = await listNotifications(me.id, { page: 1, perPage: 10 });
      expect(p1.total).toBe(25);
      expect(p1.pages).toBe(3);
      expect(p1.notifications).toHaveLength(10);
      expect(p1.notifications[0].action).toBe('n24');
      expect(p1.hasPrev).toBe(false);
      expect(p1.hasNext).toBe(true);

      const p3 = await listNotifications(me.id, { page: 3, perPage: 10 });
      expect(p3.notifications).toHaveLength(5);
      expect(p3.notifications[0].action).toBe('n4');
      expect(p3.notifications.at(-1)!.action).toBe('n0');
      expect(p3.hasPrev).toBe(true);
      expect(p3.hasNext).toBe(false);

      // 越界页：空列表，但 total/pages 仍然如实反映
      const p9 = await listNotifications(me.id, { page: 9, perPage: 10 });
      expect(p9.notifications).toHaveLength(0);
      expect(p9.hasNext).toBe(false);
    });

    it('默认每页 20', async () => {
      const me = await makeUser();
      for (let i = 0; i < 21; i++) await makeNotification({ recipientId: me.id });
      const r = await listNotifications(me.id);
      expect(r.perPage).toBe(20);
      expect(r.notifications).toHaveLength(20);
    });

    it('page/perPage 非法值被夹到合法范围（page≥1，perPage 1..100）', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id });
      expect((await listNotifications(me.id, { page: 0 })).page).toBe(1);
      expect((await listNotifications(me.id, { page: -5 })).page).toBe(1);
      expect((await listNotifications(me.id, { perPage: 0 })).perPage).toBe(1);
      expect((await listNotifications(me.id, { perPage: 9999 })).perPage).toBe(100);
    });

    it('空列表时 pages 至少为 1', async () => {
      const me = await makeUser();
      const r = await listNotifications(me.id);
      expect(r.total).toBe(0);
      expect(r.pages).toBe(1);
      expect(r.hasNext).toBe(false);
    });

    it('unreadOnly 只返回未读，且 total 也跟着变', async () => {
      const me = await makeUser();
      await makeNotification({ recipientId: me.id, read: false });
      await makeNotification({ recipientId: me.id, read: true });
      const r = await listNotifications(me.id, { unreadOnly: true });
      expect(r.total).toBe(1);
      expect(r.notifications.every((n) => !n.read)).toBe(true);
    });

    it('只返回自己的通知', async () => {
      const me = await makeUser();
      const other = await makeUser();
      await makeNotification({ recipientId: me.id, action: '我的' });
      await makeNotification({ recipientId: other.id, action: '别人的' });
      const r = await listNotifications(me.id);
      expect(r.notifications.map((n) => n.action)).toEqual(['我的']);
    });

    it('actor 为空时降级成 system（前端直接渲染 actor.username，不能是 undefined）', async () => {
      const me = await makeUser();
      const actor = await makeUser({ username: 'zhangsan' });
      await makeNotification({ recipientId: me.id, actorId: null, action: 'a', at: '2026-01-02T00:00:00.000Z' });
      await makeNotification({ recipientId: me.id, actorId: actor.id, action: 'b', at: '2026-01-01T00:00:00.000Z' });

      const { notifications } = await listNotifications(me.id);
      expect(notifications[0].actor).toEqual({ id: null, username: 'system' });
      expect(notifications[1].actor).toEqual({ id: actor.id, username: 'zhangsan' });
    });

    it('timestamp 序列化成 ISO 字符串，object 收进 {type,id}', async () => {
      const me = await makeUser();
      await prisma.notification.create({
        data: {
          id: crypto.randomUUID(),
          recipientId: me.id,
          action: 'a',
          objectType: 'blog',
          objectId: 'b1',
          read: false,
          timestamp: new Date(new Date('2026-05-06T07:08:09.000Z').getTime()),
        },
      });
      const { notifications } = await listNotifications(me.id);
      expect(notifications[0].timestamp).toBe('2026-05-06T07:08:09.000Z');
      expect(notifications[0].object).toEqual({ type: 'blog', id: 'b1' });
    });

    it('timestamp 为 NULL 的历史数据序列化成 null 而不是崩', async () => {
      const me = await makeUser();
      await prisma.notification.create({
        data: { id: crypto.randomUUID(), recipientId: me.id, action: 'a', read: false, timestamp: null },
      });
      const { notifications } = await listNotifications(me.id);
      expect(notifications[0].timestamp).toBeNull();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. vote-service
// ════════════════════════════════════════════════════════════════════════════

describe('vote-service', () => {
  // ── ID 生成 ───────────────────────────────────────────────────────────
  describe('9 位 base62 ID', () => {
    it('默认长度 9，字符集为 base62', () => {
      for (let i = 0; i < 50; i++) {
        const id = generateVoteId();
        expect(id).toHaveLength(9);
        expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
      }
    });

    it('createVote 落库的 id 也是 9 位 base62', async () => {
      const u = await makeUser();
      const r = await createVote(u.id, '标题', ['A', 'B']);
      expect('id' in r).toBe(true);
      expect((r as { id: string }).id).toMatch(/^[A-Za-z0-9]{9}$/);
    });

    it('大量生成不重复（拒绝采样没把字符集塞窄）', () => {
      const set = new Set<string>();
      for (let i = 0; i < 2000; i++) set.add(generateVoteId());
      expect(set.size).toBe(2000);
    });
  });

  // ── 创建校验 ──────────────────────────────────────────────────────────
  describe('createVote 校验', () => {
    it('标题空 / 超 200 被拒', async () => {
      const u = await makeUser();
      expect(await createVote(u.id, '   ', ['A', 'B'])).toEqual({
        error: '标题长度必须在1-200字符之间',
      });
      expect(await createVote(u.id, 'x'.repeat(201), ['A', 'B'])).toEqual({
        error: '标题长度必须在1-200字符之间',
      });
      // 200 恰好合法（边界）
      expect('id' in (await createVote(u.id, 'x'.repeat(200), ['A', 'B']))).toBe(true);
    });

    it('选项数量必须 2..10', async () => {
      const u = await makeUser();
      const msg = { error: '选项数量必须在2-10个之间' };
      expect(await createVote(u.id, 't', ['A'])).toEqual(msg);
      expect(await createVote(u.id, 't', [])).toEqual(msg);
      expect(await createVote(u.id, 't', Array.from({ length: 11 }, (_, i) => `o${i}`))).toEqual(msg);
      // 2 / 10 是合法边界
      expect('id' in (await createVote(u.id, 't', ['A', 'B']))).toBe(true);
      expect(
        'id' in (await createVote(u.id, 't', Array.from({ length: 10 }, (_, i) => `o${i}`)))
      ).toBe(true);
    });

    it('单个选项空 / 超 200 被拒', async () => {
      const u = await makeUser();
      const msg = { error: '每个选项长度必须在1-200字符之间' };
      expect(await createVote(u.id, 't', ['A', '   '])).toEqual(msg);
      expect(await createVote(u.id, 't', ['A', 'x'.repeat(201)])).toEqual(msg);
    });

    it('标题和选项都会 trim 后落库', async () => {
      const u = await makeUser();
      const r = await createVote(u.id, '  标题  ', ['  A  ', ' B ']);
      const id = (r as { id: string }).id;
      const v = await prisma.vote.findUnique({ where: { id }, include: { options: true } });
      expect(v!.title).toBe('标题');
      expect(v!.options.map((o) => o.label).sort()).toEqual(['A', 'B']);
    });

    it('选项按传入顺序写 sortOrder，初始 voteCount 为 0', async () => {
      const u = await makeUser();
      const r = await createVote(u.id, 't', ['第一', '第二', '第三']);
      const id = (r as { id: string }).id;
      const opts = await prisma.voteOption.findMany({ where: { voteId: id }, orderBy: { sortOrder: 'asc' } });
      expect(opts.map((o) => o.label)).toEqual(['第一', '第二', '第三']);
      expect(opts.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
      expect(opts.every((o) => o.voteCount === 0)).toBe(true);
    });

    it('校验失败时不消耗限频额度（校验在限频之前）', async () => {
      // 这条钉住检查顺序：如果限频先跑，用户输错 10 次标题就被锁一小时
      const u = await makeUser();
      for (let i = 0; i < 15; i++) {
        expect(await createVote(u.id, '', ['A', 'B'])).toEqual({
          error: '标题长度必须在1-200字符之间',
        });
      }
      expect('id' in (await createVote(u.id, 't', ['A', 'B']))).toBe(true);
    });
  });

  // ── 创建限频 ──────────────────────────────────────────────────────────
  describe('创建限频（10 次/时）', () => {
    it('第 11 次被限', async () => {
      const u = await makeUser();
      for (let i = 0; i < 10; i++) {
        expect('id' in (await createVote(u.id, `t${i}`, ['A', 'B']))).toBe(true);
      }
      expect(await createVote(u.id, 't10', ['A', 'B'])).toEqual({ rateLimited: true });
      // 只落库了 10 个
      expect(await prisma.vote.count({ where: { authorId: u.id } })).toBe(10);
    });

    it('限频按用户隔离，不误伤别人', async () => {
      const a = await makeUser();
      const b = await makeUser();
      for (let i = 0; i < 10; i++) await createVote(a.id, `t${i}`, ['A', 'B']);
      expect(await createVote(a.id, 'x', ['A', 'B'])).toEqual({ rateLimited: true });
      expect('id' in (await createVote(b.id, 'x', ['A', 'B']))).toBe(true);
    });
  });

  // ── 总数上限 100 ──────────────────────────────────────────────────────
  //
  // Flask app/web/vote/service.py 有 _MAX_VOTES_PER_USER = 100 的硬上限，TS 侧原本
  // 完全没迁。现已补上 —— 但**按正确语义**补：Flask 原实现数的是
  //   VoteRecord.query.filter_by(user_id=user_id).count()   ← 这人「投过」多少票
  // 而按变量名与文案该数的是「这人**创建**了多少投票」。TS 侧按后者实现，
  // 即 Vote.authorId = userId AND ignore = false。下面几条把这个差异钉死。
  describe('每用户投票总数上限 100', () => {
    it('常量与 Flask 的 100 对齐', () => {
      expect(MAX_VOTES_PER_USER).toBe(100);
    });

    it('已有 150 个投票的用户无法再创建，文案对齐 Flask', async () => {
      const u = await makeUser();
      // 直接落库绕开 10 次/时限频（限频挡不住这条上限该管的事）
      for (let i = 0; i < 150; i++) await makeVote({ authorId: u.id });
      expect(await prisma.vote.count({ where: { authorId: u.id } })).toBe(150);

      expect(await createVote(u.id, '第 151 个', ['A', 'B'])).toEqual({
        error: '每个用户最多创建 100 个投票',
      });
      // 关键：真的没落库，不只是返回了个错误
      expect(await prisma.vote.count({ where: { authorId: u.id } })).toBe(150);
    });

    it('边界：99 个时还能建第 100 个，到 100 个就被拒', async () => {
      const u = await makeUser();
      for (let i = 0; i < 99; i++) await makeVote({ authorId: u.id });

      expect('id' in (await createVote(u.id, '第 100 个', ['A', 'B']))).toBe(true);
      expect(await prisma.vote.count({ where: { authorId: u.id } })).toBe(100);

      expect(await createVote(u.id, '第 101 个', ['A', 'B'])).toEqual({
        error: '每个用户最多创建 100 个投票',
      });
    });

    it('软删除的投票不计入上限（ignore=false 过滤生效）', async () => {
      // 与 clipboard 的 200 上限不同：那边有意连软删除一起数（防删了再建刷额度），
      // 这边按 Flask 文案「最多创建 100 个投票」的字面语义，删掉的不该继续占坑。
      const u = await makeUser();
      for (let i = 0; i < 150; i++) await makeVote({ authorId: u.id, ignore: true });
      expect('id' in (await createVote(u.id, 'x', ['A', 'B']))).toBe(true);
    });

    it('数的是「自己创建的投票」，不是「自己投过的票」（Flask 原实现数错了对象）', async () => {
      // Flask 数 VoteRecord.user_id —— 投够 100 次票的人会被禁止创建投票，而创建了
      // 1000 个投票的人反而畅通无阻。这条就是冲着那个错误对象来的探针：
      // 一个投过 120 次票、但一个投票都没建过的用户，必须能正常创建。
      const author = await makeUser();
      const voter = await makeUser();
      for (let i = 0; i < 120; i++) {
        const v = await makeVote({ authorId: author.id });
        // 直接落库绕开 30 次/时的投票限频
        await prisma.voteRecord.create({
          data: { voteId: v.id, optionId: v.options[0].id, userId: voter.id, createdAt: new Date() },
        });
      }
      expect(await prisma.voteRecord.count({ where: { userId: voter.id } })).toBe(120);
      expect(await prisma.vote.count({ where: { authorId: voter.id } })).toBe(0);

      // 若照抄 Flask 的错误实现，这里会返回「每个用户最多创建 100 个投票」
      expect('id' in (await createVote(voter.id, '我的第一个投票', ['A', 'B']))).toBe(true);
    });

    it('上限按用户隔离', async () => {
      const a = await makeUser();
      const b = await makeUser();
      for (let i = 0; i < 100; i++) await makeVote({ authorId: a.id });
      expect(await createVote(a.id, 'x', ['A', 'B'])).toEqual({
        error: '每个用户最多创建 100 个投票',
      });
      expect('id' in (await createVote(b.id, 'x', ['A', 'B']))).toBe(true);
    });

    it('API route 把上限错误透传成 400 + 同样的文案', async () => {
      const u = await makeUser();
      for (let i = 0; i < 100; i++) await makeVote({ authorId: u.id });

      mockCurrentUser = u as SafeUser;
      const res = await votesPost(
        new Request('http://x/api/votes', {
          method: 'POST',
          body: JSON.stringify({ title: 't', options: ['A', 'B'] }),
        })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 400, message: '每个用户最多创建 100 个投票' });
    });
  });

  // ── 每人一票 ──────────────────────────────────────────────────────────
  describe('每人一票', () => {
    it('首投成功并把 vote_count 加 1', async () => {
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id });
      expect(await castVote(id, options[0].id, u.id)).toEqual({ ok: true });

      const opt = await prisma.voteOption.findUnique({ where: { id: options[0].id } });
      expect(opt!.voteCount).toBe(1);
      expect(await prisma.voteRecord.count({ where: { voteId: id, userId: u.id } })).toBe(1);
    });

    it('同一用户重复投票被拒，且计数不涨', async () => {
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id });
      await castVote(id, options[0].id, u.id);

      expect(await castVote(id, options[0].id, u.id)).toEqual({ error: '您已经投过票了', status: 400 });
      // 换个选项也不行 —— 「改票」不是被支持的语义
      expect(await castVote(id, options[1].id, u.id)).toEqual({ error: '您已经投过票了', status: 400 });

      const opts = await prisma.voteOption.findMany({ where: { voteId: id } });
      expect(opts.reduce((s, o) => s + (o.voteCount ?? 0), 0)).toBe(1);
      expect(await prisma.voteRecord.count({ where: { voteId: id } })).toBe(1);
    });

    it('并发投票（同一用户 5 个请求）只有一个成功', async () => {
      // 先查后插在并发下必然漏，真正的防线是 VoteRecord 的唯一约束 (vote_id, user_id)
      // + castVote 里对 P2002 的捕获。这条用例就是冲着那道防线来的。
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id });

      const results = await Promise.all(
        Array.from({ length: 5 }, () => castVote(id, options[0].id, u.id))
      );

      const ok = results.filter((r) => 'ok' in r);
      expect(ok).toHaveLength(1);
      // 其余全是「已投过」，不能是 500 / 未捕获异常
      expect(results.filter((r) => 'error' in r && r.error === '您已经投过票了')).toHaveLength(4);

      // 最要紧的是库里的最终状态：一条记录、计数为 1
      expect(await prisma.voteRecord.count({ where: { voteId: id, userId: u.id } })).toBe(1);
      const opts = await prisma.voteOption.findMany({ where: { voteId: id } });
      expect(opts.reduce((s, o) => s + (o.voteCount ?? 0), 0)).toBe(1);
    });

    it('不同用户各投各的互不影响，计数与记录数对得上', async () => {
      const author = await makeUser();
      const { id, options } = await makeVote({ authorId: author.id, labels: ['A', 'B'] });
      const voters = await Promise.all([makeUser(), makeUser(), makeUser()]);

      expect(await castVote(id, options[0].id, voters[0].id)).toEqual({ ok: true });
      expect(await castVote(id, options[0].id, voters[1].id)).toEqual({ ok: true });
      expect(await castVote(id, options[1].id, voters[2].id)).toEqual({ ok: true });

      const opts = await prisma.voteOption.findMany({ where: { voteId: id }, orderBy: { sortOrder: 'asc' } });
      expect(opts.map((o) => o.voteCount)).toEqual([2, 1]);
      // 冗余计数 vs 真实记录数 —— 对不上就是前端显示错票数
      expect(await prisma.voteRecord.count({ where: { voteId: id } })).toBe(3);
    });
  });

  // ── 选项校验 / 跨投票串号 ─────────────────────────────────────────────
  describe('选项校验', () => {
    it('投给不存在的选项 → 选项不存在', async () => {
      const u = await makeUser();
      const { id } = await makeVote({ authorId: u.id });
      expect(await castVote(id, 999999, u.id)).toEqual({ error: '选项不存在', status: 400 });
      expect(await prisma.voteRecord.count()).toBe(0);
    });

    it('投给别的投票的选项（跨投票串号）被拒，且不污染那边的计数', async () => {
      // 选项 id 是全局自增整数，只按 id 查会串号：A 投票的请求把 B 投票的票数刷上去。
      // castVote 必须用 (id, voteId) 双条件查 —— 这条就是那个双条件的探针。
      const u = await makeUser();
      const a = await makeVote({ authorId: u.id, labels: ['A1', 'A2'] });
      const b = await makeVote({ authorId: u.id, labels: ['B1', 'B2'] });

      expect(await castVote(a.id, b.options[0].id, u.id)).toEqual({
        error: '选项不存在',
        status: 400,
      });

      // B 的计数不能被 A 的请求碰到
      const bOpt = await prisma.voteOption.findUnique({ where: { id: b.options[0].id } });
      expect(bOpt!.voteCount).toBe(0);
      expect(await prisma.voteRecord.count()).toBe(0);
    });
  });

  // ── 软删除 / 锁定 ─────────────────────────────────────────────────────
  describe('软删除与锁定', () => {
    it('投票不存在 → 404', async () => {
      const u = await makeUser();
      expect(await castVote('nonexist9', 1, u.id)).toEqual({ error: '投票不存在', status: 404 });
    });

    it('软删除（ignore=true）的投票视为不存在 → 404', async () => {
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id, ignore: true });
      expect(await castVote(id, options[0].id, u.id)).toEqual({ error: '投票不存在', status: 404 });
      expect(await prisma.voteRecord.count()).toBe(0);
    });

    it('锁定的投票 → 400，解锁后可投', async () => {
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id, isLocked: true });
      expect(await castVote(id, options[0].id, u.id)).toEqual({
        error: '投票已锁定，无法投票',
        status: 400,
      });
      expect(await prisma.voteRecord.count()).toBe(0);

      await prisma.vote.update({ where: { id }, data: { isLocked: false } });
      expect(await castVote(id, options[0].id, u.id)).toEqual({ ok: true });
    });

    it('已投票后再锁定：已有记录保留，新投票被拒', async () => {
      const author = await makeUser();
      const voter = await makeUser();
      const { id, options } = await makeVote({ authorId: author.id });
      await castVote(id, options[0].id, voter.id);

      await prisma.vote.update({ where: { id }, data: { isLocked: true } });

      const other = await makeUser();
      expect(await castVote(id, options[0].id, other.id)).toEqual({
        error: '投票已锁定，无法投票',
        status: 400,
      });
      // 锁定不该抹掉已有的票
      expect(await prisma.voteRecord.count({ where: { voteId: id } })).toBe(1);
      const opt = await prisma.voteOption.findUnique({ where: { id: options[0].id } });
      expect(opt!.voteCount).toBe(1);
    });

    it('listVotes 排除软删除，最新在前，带 optionCount / totalVotes', async () => {
      const u = await makeUser({ username: 'author1' });
      const alive = await makeVote({ authorId: u.id, labels: ['A', 'B', 'C'] });
      await makeVote({ authorId: u.id, ignore: true }); // 软删除的不该出现
      await castVote(alive.id, alive.options[0].id, u.id);

      const list = await listVotes();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(alive.id);
      expect(list[0].authorName).toBe('author1');
      expect(list[0].optionCount).toBe(3);
      expect(list[0].totalVotes).toBe(1);
    });

    it('getVoteDetail 对软删除的投票返回 null', async () => {
      const u = await makeUser();
      const { id } = await makeVote({ authorId: u.id, ignore: true });
      expect(await getVoteDetail(id, u.id)).toBeNull();
    });
  });

  // ── 详情 ──────────────────────────────────────────────────────────────
  describe('getVoteDetail', () => {
    it('百分比按票数算，userVoted 反映当前用户的选择', async () => {
      const author = await makeUser();
      const { id, options } = await makeVote({ authorId: author.id, labels: ['A', 'B'] });
      const v1 = await makeUser();
      const v2 = await makeUser();
      const v3 = await makeUser();
      await castVote(id, options[0].id, v1.id);
      await castVote(id, options[0].id, v2.id);
      await castVote(id, options[1].id, v3.id);

      const d = (await getVoteDetail(id, v3.id))!;
      expect(d.totalVotes).toBe(3);
      expect(d.userVoted).toBe(options[1].id);
      expect(d.isCreator).toBe(false);
      expect(d.options.map((o) => o.count)).toEqual([2, 1]);
      expect(d.options.map((o) => o.percentage)).toEqual([66.7, 33.3]); // 一位小数

      // 没投过的用户 userVoted 为 null；作者 isCreator 为 true
      const nobody = await makeUser();
      expect((await getVoteDetail(id, nobody.id))!.userVoted).toBeNull();
      expect((await getVoteDetail(id, author.id))!.isCreator).toBe(true);
    });

    it('零票时百分比为 0 而不是 NaN', async () => {
      const u = await makeUser();
      const { id } = await makeVote({ authorId: u.id });
      const d = (await getVoteDetail(id, null))!;
      expect(d.totalVotes).toBe(0);
      expect(d.options.every((o) => o.percentage === 0)).toBe(true);
    });

    it('匿名访客（currentUserId=null）不查记录，userVoted 为 null，isCreator 为 false', async () => {
      const u = await makeUser();
      const { id, options } = await makeVote({ authorId: u.id });
      await castVote(id, options[0].id, u.id);
      const d = (await getVoteDetail(id, null))!;
      expect(d.userVoted).toBeNull();
      expect(d.isCreator).toBe(false);
    });

    it('选项按 sortOrder 返回', async () => {
      const u = await makeUser();
      const r = await createVote(u.id, 't', ['甲', '乙', '丙']);
      const id = (r as { id: string }).id;
      const d = (await getVoteDetail(id, null))!;
      expect(d.options.map((o) => o.label)).toEqual(['甲', '乙', '丙']);
    });
  });

  // ── 投票限频 ──────────────────────────────────────────────────────────
  describe('投票限频（30 次/时）', () => {
    it('第 31 次被限', async () => {
      const author = await makeUser();
      const voter = await makeUser();
      // 造 31 个投票，让 voter 逐个投 —— 每人一票的约束不会提前挡住
      const votes = [];
      for (let i = 0; i < 31; i++) votes.push(await makeVote({ authorId: author.id }));

      for (let i = 0; i < 30; i++) {
        expect(await castVote(votes[i].id, votes[i].options[0].id, voter.id)).toEqual({ ok: true });
      }
      expect(await castVote(votes[30].id, votes[30].options[0].id, voter.id)).toEqual({
        rateLimited: true,
      });
      expect(await prisma.voteRecord.count({ where: { userId: voter.id } })).toBe(30);
    });

    it('限频跑在存在性检查之后：投不存在的投票不吃配额', async () => {
      // Flask cast_vote 是先查投票/选项/是否已投，最后才 check 限频；TS 原先把
      // rateLimit 提到了最前面，后果是对不存在的投票狂发请求就能把用户自己的
      // 30 次/时 配额烧光（自伤）。现已对齐 Flask 的顺序，这条钉住它。
      const u = await makeUser();
      for (let i = 0; i < 30; i++) {
        expect(await castVote('nonexist9', 1, u.id)).toEqual({ error: '投票不存在', status: 404 });
      }
      // 配额没被无效请求碰过，真投票照常成功
      const { id, options } = await makeVote({ authorId: u.id });
      expect(await castVote(id, options[0].id, u.id)).toEqual({ ok: true });
    });

    it('选项不存在 / 已投过 同样不吃配额', async () => {
      // 存在性检查的三道关（投票、选项、是否已投）都该在限频之前 —— 任何一道
      // 漏到限频后面，用户都能用无效请求把自己锁死。
      const u = await makeUser();
      const target = await makeVote({ authorId: u.id });

      // 1) 选项不存在 ×15
      for (let i = 0; i < 15; i++) {
        expect(await castVote(target.id, 999999, u.id)).toEqual({ error: '选项不存在', status: 400 });
      }
      // 2) 真投一票（唯一消耗配额的一次）
      expect(await castVote(target.id, target.options[0].id, u.id)).toEqual({ ok: true });
      // 3) 重复投票 ×20
      for (let i = 0; i < 20; i++) {
        expect(await castVote(target.id, target.options[0].id, u.id)).toEqual({
          error: '您已经投过票了',
          status: 400,
        });
      }

      // 上面 36 次调用只该消耗 1 次配额，剩下 29 次仍可用
      const votes = [];
      for (let i = 0; i < 29; i++) votes.push(await makeVote({ authorId: u.id }));
      for (const v of votes) {
        expect(await castVote(v.id, v.options[0].id, u.id)).toEqual({ ok: true });
      }
      // 第 31 次真投票才被限
      const extra = await makeVote({ authorId: u.id });
      expect(await castVote(extra.id, extra.options[0].id, u.id)).toEqual({ rateLimited: true });
    });

    it('被限频时不落库、不涨计数', async () => {
      const author = await makeUser();
      const voter = await makeUser();
      const votes = [];
      for (let i = 0; i < 31; i++) votes.push(await makeVote({ authorId: author.id }));
      for (let i = 0; i < 30; i++) await castVote(votes[i].id, votes[i].options[0].id, voter.id);

      const last = votes[30];
      expect(await castVote(last.id, last.options[0].id, voter.id)).toEqual({ rateLimited: true });
      // 限频返回发生在 create 之前，事务里不该留下任何痕迹
      expect(await prisma.voteRecord.count({ where: { voteId: last.id } })).toBe(0);
      const opt = await prisma.voteOption.findUnique({ where: { id: last.options[0].id } });
      expect(opt!.voteCount).toBe(0);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. clipboard-service
// ════════════════════════════════════════════════════════════════════════════

describe('clipboard-service', () => {
  // ── 短 ID ─────────────────────────────────────────────────────────────
  it('createClip 生成 8 位短 ID（小写字母 + 数字）', async () => {
    const u = await makeUser();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await createClip(u.id, { title: 't', content: 'c' });
      expect(r.ok).toBe(true);
      const id = (r as { ok: true; id: string }).id;
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(20);
  });

  it('createClip 同时写 ClipBoard 与 ClipText（一对一分表）', async () => {
    const u = await makeUser();
    const r = (await createClip(u.id, { title: '标题', content: '正文正文' })) as {
      ok: true;
      id: string;
    };
    const clip = await prisma.clipBoard.findUnique({
      where: { id: r.id },
      include: { content: true },
    });
    expect(clip!.title).toBe('标题');
    expect(clip!.authorId).toBe(u.id);
    expect(clip!.ignore).toBe(false);
    expect(clip!.content!.content).toBe('正文正文');
  });

  it('publicity 省略时默认公开（对齐模型 default true）', async () => {
    const u = await makeUser();
    const r = (await createClip(u.id, { title: 't', content: 'c' })) as { ok: true; id: string };
    const clip = await prisma.clipBoard.findUnique({ where: { id: r.id } });
    expect(clip!.publicity).toBe(true);

    const r2 = (await createClip(u.id, { title: 't', content: 'c', publicity: false })) as {
      ok: true;
      id: string;
    };
    expect((await prisma.clipBoard.findUnique({ where: { id: r2.id } }))!.publicity).toBe(false);
  });

  // ── 总数上限 ──────────────────────────────────────────────────────────
  describe('每用户总数上限 200', () => {
    it('常量与 Flask 的 200 对齐', () => {
      expect(CLIP_PER_USER_MAX).toBe(200);
    });

    it('已有 200 条时仍放行（判定是 count > 200，实际能存到 201 条）', async () => {
      // Flask `if clip_count > 200: return None` 就是这个 off-by-one，TS 照抄了。
      // 这条钉住「和 Flask 一致」这件事本身 —— 见交付说明的讨论。
      const u = await makeUser();
      for (let i = 0; i < 200; i++) {
        await prisma.clipBoard.create({
          data: { id: `seed${String(i).padStart(4, '0')}`, title: 't', authorId: u.id, createdAt: new Date() },
        });
      }
      const r = await createClip(u.id, { title: '第 201 条', content: 'c' });
      expect(r.ok).toBe(true);
      expect(await prisma.clipBoard.count({ where: { authorId: u.id } })).toBe(201);
    });

    it('已有 201 条时拒绝，返回 limit 且不落库', async () => {
      const u = await makeUser();
      for (let i = 0; i < 201; i++) {
        await prisma.clipBoard.create({
          data: { id: `seed${String(i).padStart(4, '0')}`, title: 't', authorId: u.id, createdAt: new Date() },
        });
      }
      expect(await createClip(u.id, { title: '第 202 条', content: 'c' })).toEqual({
        ok: false,
        reason: 'limit',
      });
      expect(await prisma.clipBoard.count({ where: { authorId: u.id } })).toBe(201);
    });

    it('软删除的剪贴板仍计入上限（对齐 Flask：count 不带 ignore 过滤）', async () => {
      // 这是有意的 —— 否则删了再建就能无限刷。但对用户不直观，值得记一笔。
      const u = await makeUser();
      for (let i = 0; i < 201; i++) {
        await prisma.clipBoard.create({
          data: {
            id: `seed${String(i).padStart(4, '0')}`,
            title: 't',
            authorId: u.id,
            ignore: true, // 全是软删除的
            createdAt: new Date(),
          },
        });
      }
      expect(await createClip(u.id, { title: 'x', content: 'c' })).toEqual({
        ok: false,
        reason: 'limit',
      });
    });

    it('上限按用户隔离', async () => {
      const a = await makeUser();
      const b = await makeUser();
      for (let i = 0; i < 201; i++) {
        await prisma.clipBoard.create({
          data: { id: `seed${String(i).padStart(4, '0')}`, title: 't', authorId: a.id, createdAt: new Date() },
        });
      }
      expect(await createClip(a.id, { title: 'x', content: 'c' })).toEqual({ ok: false, reason: 'limit' });
      expect((await createClip(b.id, { title: 'x', content: 'c' })).ok).toBe(true);
    });
  });

  // ── 可见性 ────────────────────────────────────────────────────────────
  describe('公开 / 私有可见性', () => {
    it('公开剪贴板任何人（含未登录）都能读', async () => {
      const author = await makeUser({ username: 'zhangsan' });
      const other = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'hello', publicity: true })) as {
        ok: true;
        id: string;
      };

      for (const viewer of [author.id, other.id, undefined]) {
        const got = await getClip(r.id, viewer);
        expect(got.ok).toBe(true);
        expect((got as { ok: true; clip: { content: string } }).clip.content).toBe('hello');
      }
      expect(((await getClip(r.id)) as { ok: true; clip: { authorName: string } }).clip.authorName).toBe(
        'zhangsan'
      );
    });

    it('私有剪贴板仅作者可读，其他人 forbidden', async () => {
      // 这条是数据泄漏的直接探针：漏了 publicity 判断，别人的私有内容就被读出来
      const author = await makeUser();
      const other = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'secret', publicity: false })) as {
        ok: true;
        id: string;
      };

      const mine = await getClip(r.id, author.id);
      expect(mine.ok).toBe(true);
      expect((mine as { ok: true; clip: { content: string } }).clip.content).toBe('secret');

      expect(await getClip(r.id, other.id)).toEqual({ ok: false, reason: 'forbidden' });
      // 未登录访客同样拿不到
      expect(await getClip(r.id, undefined)).toEqual({ ok: false, reason: 'forbidden' });
      // 注意：forbidden 而不是 not_found —— 会暴露「该 id 存在」，但对齐 Flask abort(403)
    });

    it('★ 站长能看别人的私有剪贴板（对齐 Flask 的 `and not current_user.is_owner`）', async () => {
      // 这个例外一度漏掉：getClip 只判了「非作者 → forbidden」，站长访问会吃 403，
      // 连详情页上那个只对他显示的「删除」按钮都够不着 —— 而删除权限是给了他的。
      // 上面那条用例覆盖了「别人看不到」，却没覆盖站长，于是漏网。
      const author = await makeUser();
      const r = (await createClip(author.id, {
        title: 't',
        content: 'secret',
        publicity: false,
      })) as { ok: true; id: string };

      const asOwner = await getClip(r.id, 'some-owner-id', true);
      expect(asOwner.ok).toBe(true);
      expect((asOwner as { ok: true; clip: { content: string } }).clip.content).toBe('secret');

      // 反面：同一个人不带站长身份就该被挡 —— 证明放行确实来自 viewerIsOwner，
      // 而不是这条用例恰好选了个能过的 viewerId
      expect(await getClip(r.id, 'some-owner-id', false)).toEqual({
        ok: false,
        reason: 'forbidden',
      });
    });

    it('viewerIsOwner 不影响公开剪贴板（不该有副作用）', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, {
        title: 't',
        content: 'open',
        publicity: true,
      })) as { ok: true; id: string };
      for (const owner of [true, false]) {
        const got = await getClip(r.id, 'anyone', owner);
        expect(got.ok).toBe(true);
      }
    });

    it('publicity 为 NULL 的历史数据视为公开（对齐模型 default true）', async () => {
      const author = await makeUser();
      const other = await makeUser();
      await prisma.clipBoard.create({
        data: { id: 'nullpub1', title: 't', authorId: author.id, publicity: null, createdAt: new Date() },
      });
      const got = await getClip('nullpub1', other.id);
      expect(got.ok).toBe(true);
      expect((got as { ok: true; clip: { publicity: boolean } }).clip.publicity).toBe(true);
    });

    it('没有 ClipText 记录时 content 降级成空串而不是崩', async () => {
      const author = await makeUser();
      await prisma.clipBoard.create({
        data: { id: 'notext01', title: 't', authorId: author.id, createdAt: new Date() },
      });
      const got = await getClip('notext01', author.id);
      expect(got.ok).toBe(true);
      expect((got as { ok: true; clip: { content: string } }).clip.content).toBe('');
    });

    it('id 不存在 → not_found', async () => {
      expect(await getClip('nosuchid')).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  // ── 软删除 ────────────────────────────────────────────────────────────
  describe('软删除语义', () => {
    it('ignore=true 后对所有人都是 not_found（包括作者）', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'c' })) as { ok: true; id: string };
      await prisma.clipBoard.update({ where: { id: r.id }, data: { ignore: true } });

      expect(await getClip(r.id, author.id)).toEqual({ ok: false, reason: 'not_found' });
      expect(await getClip(r.id)).toEqual({ ok: false, reason: 'not_found' });
      // 软删除 ≠ 物理删除：行还在，正文也还在
      expect(await prisma.clipBoard.count({ where: { id: r.id } })).toBe(1);
      expect(await prisma.clipText.count({ where: { clipId: r.id } })).toBe(1);
    });

    it('恢复（ignore=false）后又能读到，正文原样', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: '原文' })) as { ok: true; id: string };
      await prisma.clipBoard.update({ where: { id: r.id }, data: { ignore: true } });
      await prisma.clipBoard.update({ where: { id: r.id }, data: { ignore: false } });

      const got = await getClip(r.id, author.id);
      expect((got as { ok: true; clip: { content: string } }).clip.content).toBe('原文');
    });

    it('listUserClips 排除软删除，按 createdAt 倒序，只列自己的', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const mk = async (id: string, iso: string, ignore = false, authorId = me.id) =>
        prisma.clipBoard.create({
          data: {
            id,
            title: id,
            authorId,
            ignore,
            // 库里时间戳是 INTEGER 毫秒，历史数据这样造
            createdAt: new Date(new Date(iso).getTime()),
          },
        });
      await mk('aaaaaaaa', '2026-01-01T00:00:00.000Z');
      await mk('cccccccc', '2026-03-01T00:00:00.000Z');
      await mk('bbbbbbbb', '2026-02-01T00:00:00.000Z');
      await mk('dddddddd', '2026-04-01T00:00:00.000Z', true); // 软删除
      await mk('eeeeeeee', '2026-05-01T00:00:00.000Z', false, other.id); // 别人的

      const list = await listUserClips(me.id);
      expect(list.map((c) => c.id)).toEqual(['cccccccc', 'bbbbbbbb', 'aaaaaaaa']);
    });
  });

  // ── 编辑 ──────────────────────────────────────────────────────────────
  describe('updateClip', () => {
    it('作者本人可编辑标题 / 正文 / 可见性', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: '旧标题', content: '旧正文', publicity: true })) as {
        ok: true;
        id: string;
      };

      expect(await updateClip(r.id, author.id, { title: '新标题', content: '新正文', publicity: false })).toEqual(
        { ok: true, id: r.id }
      );

      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id }, include: { content: true } });
      expect(clip!.title).toBe('新标题');
      expect(clip!.publicity).toBe(false);
      expect(clip!.content!.content).toBe('新正文');
    });

    it('非作者不能编辑 → forbidden，且内容一个字都没变', async () => {
      // Flask edit 路由只认作者，连 owner 都没例外 —— 这条钉住「没有偷偷加后门」
      const author = await makeUser();
      const other = await makeUser({ role: 'owner' }); // 站长也不行
      const r = (await createClip(author.id, { title: '原标题', content: '原正文' })) as {
        ok: true;
        id: string;
      };

      expect(await updateClip(r.id, other.id, { title: '篡改', content: '篡改', publicity: false })).toEqual({
        ok: false,
        reason: 'forbidden',
      });

      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id }, include: { content: true } });
      expect(clip!.title).toBe('原标题');
      expect(clip!.content!.content).toBe('原正文');
    });

    it('软删除的剪贴板不能编辑 → not_found（连作者也不行）', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: '原标题', content: '原正文' })) as {
        ok: true;
        id: string;
      };
      await prisma.clipBoard.update({ where: { id: r.id }, data: { ignore: true } });

      expect(await updateClip(r.id, author.id, { title: '新', content: '新', publicity: true })).toEqual({
        ok: false,
        reason: 'not_found',
      });
      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id }, include: { content: true } });
      expect(clip!.title).toBe('原标题');
      expect(clip!.content!.content).toBe('原正文');
    });

    it('不存在的 id → not_found', async () => {
      const u = await makeUser();
      expect(await updateClip('nosuchid', u.id, { title: 't', content: 'c', publicity: true })).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('没有 ClipText 记录时 upsert 出正文（历史数据兼容）', async () => {
      const author = await makeUser();
      await prisma.clipBoard.create({
        data: { id: 'notext02', title: 't', authorId: author.id, createdAt: new Date() },
      });
      expect(await updateClip('notext02', author.id, { title: 't2', content: '补上的正文', publicity: true })).toEqual(
        { ok: true, id: 'notext02' }
      );
      const ct = await prisma.clipText.findUnique({ where: { clipId: 'notext02' } });
      expect(ct!.content).toBe('补上的正文');
    });

    it('编辑不改动 ignore（保留软删除语义）', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'c' })) as { ok: true; id: string };
      await updateClip(r.id, author.id, { title: 't2', content: 'c2', publicity: true });
      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id } });
      expect(clip!.ignore).toBe(false);
    });

    it('service 层自己校验长度：超长标题 / 正文被拒且不落库', async () => {
      // 长度上限原先只活在 API route 里（见下一组用例），service 完全不设防 ——
      // 任何绕过 route 的调用方（CLI、其他 service）都能写超长数据。校验已下沉到
      // service，这条钉住它：route 和 service 现在是两道独立的防线。
      const author = await makeUser();

      expect(
        await createClip(author.id, {
          title: 'x'.repeat(41), // > CLIP_TITLE_MAX(40)
          content: 'c',
        })
      ).toEqual({ ok: false, reason: 'title_too_long' });

      expect(
        await createClip(author.id, {
          title: 't',
          content: 'y'.repeat(CLIP_CONTENT_MAX + 1), // > 50000
        })
      ).toEqual({ ok: false, reason: 'content_too_long' });

      // 空标题也走 title_too_long（对齐 Flask：len<1 与 len>40 同一分支）
      expect(await createClip(author.id, { title: '', content: 'c' })).toEqual({
        ok: false,
        reason: 'title_too_long',
      });

      // 一条都没落库
      expect(await prisma.clipBoard.count({ where: { authorId: author.id } })).toBe(0);

      // 边界：恰好 40 / 50000 合法
      const okRes = await createClip(author.id, {
        title: 'x'.repeat(CLIP_TITLE_MAX),
        content: 'y'.repeat(CLIP_CONTENT_MAX),
      });
      expect(okRes.ok).toBe(true);
    });

    it('updateClip 同样校验长度，且原内容一个字都没变', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: '原标题', content: '原正文' })) as {
        ok: true;
        id: string;
      };

      expect(
        await updateClip(r.id, author.id, { title: 'z'.repeat(41), content: 'c', publicity: true })
      ).toEqual({ ok: false, reason: 'title_too_long' });

      expect(
        await updateClip(r.id, author.id, {
          title: 't',
          content: 'w'.repeat(CLIP_CONTENT_MAX + 1),
          publicity: true,
        })
      ).toEqual({ ok: false, reason: 'content_too_long' });

      expect(await updateClip(r.id, author.id, { title: '', content: 'c', publicity: true })).toEqual({
        ok: false,
        reason: 'title_too_long',
      });

      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id }, include: { content: true } });
      expect(clip!.title).toBe('原标题');
      expect(clip!.content!.content).toBe('原正文');
    });

    it('长度校验先于存在性 / 权限检查（纯输入校验不该先打库）', async () => {
      // 顺序本身不影响安全性，但钉一下以免以后有人把校验挪到查库之后，
      // 让「不存在的 id + 超长标题」这种请求白白多打一次库。
      const u = await makeUser();
      expect(
        await updateClip('nosuchid', u.id, { title: 'z'.repeat(41), content: 'c', publicity: true })
      ).toEqual({ ok: false, reason: 'title_too_long' });
    });
  });

  // ── 长度上限与文案（活在 API route 层）─────────────────────────────────
  //
  // 「标题/内容长度上限与文案」这两件事 service 层没有，只有 route 有。
  // 要验文案就得打到 route，所以这组 mock 掉 getCurrentUser 直接调 PUT/POST handler。
  describe('长度上限与错误文案（API route 层）', () => {
    it('常量与 Flask validator() 对齐', () => {
      expect(CLIP_TITLE_MAX).toBe(40); // app/web/clipboard/__init__.py: len(title) > 40
      expect(CLIP_CONTENT_MAX).toBe(50000); // len(content) > 50000
    });

    it('PUT /api/clipboard/:id 的长度校验与文案', async () => {
      const author = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'c' })) as { ok: true; id: string };

      mockCurrentUser = author as SafeUser;
      const call = (body: unknown) =>
        clipPut(new Request('http://x/api/clipboard/x', { method: 'PUT', body: JSON.stringify(body) }), {
          params: Promise.resolve({ id: r.id }),
        });

      // 标题超 40 → 'title too long'
      const tooLongTitle = await (
        await call({ title: 'x'.repeat(41), content: 'c', publicity: true })
      ).json();
      expect(tooLongTitle).toMatchObject({ code: 400, message: 'title too long' });

      // 标题空串同样走 'title too long' 这条文案（对齐 Flask：len<1 与 len>40 同一分支）
      const emptyTitle = await (await call({ title: '', content: 'c', publicity: true })).json();
      expect(emptyTitle).toMatchObject({ code: 400, message: 'title too long' });

      // 正文超 50000 → 'content too long'
      const tooLongContent = await (
        await call({ title: 't', content: 'y'.repeat(50001), publicity: true })
      ).json();
      expect(tooLongContent).toMatchObject({ code: 400, message: 'content too long' });

      // publicity 非布尔 → 'wrong publicity format'
      const badPub = await (await call({ title: 't', content: 'c', publicity: 'yes' })).json();
      expect(badPub).toMatchObject({ code: 400, message: 'wrong publicity format' });

      // 边界：恰好 40 / 50000 合法
      const okRes = await call({ title: 'x'.repeat(40), content: 'y'.repeat(50000), publicity: true });
      expect(await okRes.json()).toMatchObject({ code: 200, message: 'success', id: r.id });

      // 校验全部拦在 service 之前 —— 库里只有最后那次合法写入的内容
      const clip = await prisma.clipBoard.findUnique({ where: { id: r.id }, include: { content: true } });
      expect(clip!.title).toBe('x'.repeat(40));
      expect(clip!.content!.content).toHaveLength(50000);
    });

    it('PUT 非作者 → 403 「您不是该文章作者，无法编辑！」', async () => {
      const author = await makeUser();
      const other = await makeUser();
      const r = (await createClip(author.id, { title: 't', content: 'c' })) as { ok: true; id: string };

      mockCurrentUser = other as SafeUser;
      const res = await clipPut(
        new Request('http://x', { method: 'PUT', body: JSON.stringify({ title: 't', content: 'c', publicity: true }) }),
        { params: Promise.resolve({ id: r.id }) }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 403, message: '您不是该文章作者，无法编辑！' });
    });

    it('PUT 未登录 → 401', async () => {
      mockCurrentUser = null;
      const res = await clipPut(
        new Request('http://x', { method: 'PUT', body: JSON.stringify({ title: 't', content: 'c', publicity: true }) }),
        { params: Promise.resolve({ id: 'whatever' }) }
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 401, message: '请先登录' });
    });

    it('POST /api/clipboard 超限 → 400 「一个用户只能发布200篇云剪贴板！」', async () => {
      const author = await makeUser();
      for (let i = 0; i < 201; i++) {
        await prisma.clipBoard.create({
          data: { id: `seed${String(i).padStart(4, '0')}`, title: 't', authorId: author.id, createdAt: new Date() },
        });
      }

      mockCurrentUser = author as SafeUser;
      const res = await clipPost(
        new Request('http://x', { method: 'POST', body: JSON.stringify({ title: 't', content: 'c', publicity: true }) })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 400, message: '一个用户只能发布200篇云剪贴板！' });
    });
  });
});
