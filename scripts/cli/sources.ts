// ─────────────────────────────────────────────────────────────────────────────
// sources.ts —— 交互式向导的「先搜后选」数据源
//
// 【这是「不用背命令」的落点】命令行式那一条路径永远收 `<id>`；向导这条路径让操作者
// 输入一个关键词、看到候选列表、从中挑一个 —— 不需要知道任何 UUID / 短 id。
//
// 每个 source 的 `value` 就是命令真正要的那个值（多数是实体 id，用户是用户名），
// 所以向导收集完可以直接喂给 run()，不需要再转换一次。
//
// ⚠️ 这里一律用函数内的 `await import()` 调服务层，不在顶层静态 import ——
//    保住「--help 不加载 Prisma」（有静态守卫盯着）。
// ─────────────────────────────────────────────────────────────────────────────

import type { Choice, SearchSource } from './types';

/** 把可能很长的正文压成一行预览（表格与候选列表都用得上）。 */
export function preview(text: string | null | undefined, max = 40): string {
  if (!text) return '—';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/** 用户。value = 用户名（CLI 各命令收的都是用户名）。 */
export function userSource(): SearchSource {
  const toChoices = (users: { username: string; role: string; email: string; currentlyBanned: boolean }[]): Choice[] =>
    users.map((u) => ({
      value: u.username,
      label: u.username,
      hint: `${u.role}${u.currentlyBanned ? ' · 禁言中' : ''} · ${u.email}`,
    }));

  return {
    emptyHint: '用户名或邮箱片段',
    async initial() {
      const { listUsers } = await import('../../src/lib/admin-user-service');
      return toChoices((await listUsers({ page: 1, perPage: 20 })).users);
    },
    async search(q) {
      const { listUsers } = await import('../../src/lib/admin-user-service');
      return toChoices((await listUsers({ page: 1, perPage: 20, search: q })).users);
    },
    allowFreeTextFallback: true, // 搜不到时允许把输入原样当用户名
  };
}

/** 文章。value = blogId（UUID）。 */
export function blogSource(): SearchSource {
  return {
    emptyHint: '标题 / 正文 / 作者片段',
    async initial() {
      const { listAdminBlogs } = await import('../../src/lib/admin-blog-service');
      const r = await listAdminBlogs({ page: 1, perPage: 20, status: 'all' });
      return r.blogs.map((b) => ({
        value: b.id,
        label: b.title,
        hint: `${b.author?.username ?? '—'} · ${b.ignore ? '已删除' : '正常'}`,
      }));
    },
    async search(q) {
      const { listAdminBlogs } = await import('../../src/lib/admin-blog-service');
      // 向导里搜索一律用 'all' 范围 —— 操作者常常只记得正文里的某个词
      const r = await listAdminBlogs({ page: 1, perPage: 20, search: q, status: 'all', searchScope: 'all' });
      return r.blogs.map((b) => ({
        value: b.id,
        label: b.title,
        hint: `${b.author?.username ?? '—'} · ${b.ignore ? '已删除' : '正常'}`,
      }));
    },
  };
}

/** 评论。value = commentId。 */
export function commentSource(opts: { blogId?: string; includeDeleted?: boolean } = {}): SearchSource {
  const status = opts.includeDeleted === false ? 'active' : 'all';
  const toChoices = (
    rows: { id: string; content: string; isDeleted: boolean | null; author: { username: string } | null }[]
  ): Choice[] =>
    rows.map((c) => ({
      value: c.id,
      label: preview(c.content),
      hint: `${c.author?.username ?? '—'}${c.isDeleted ? ' · 已删除' : ''}`,
    }));

  return {
    emptyHint: '评论正文 / 作者 / 文章标题片段',
    async initial() {
      const { listAdminComments } = await import('../../src/lib/admin-comment-service');
      const r = await listAdminComments({ page: 1, perPage: 20, blogId: opts.blogId, status });
      return toChoices(r.comments);
    },
    async search(q) {
      const { listAdminComments } = await import('../../src/lib/admin-comment-service');
      const r = await listAdminComments({ page: 1, perPage: 20, search: q, blogId: opts.blogId, status });
      return toChoices(r.comments);
    },
  };
}

/** 云剪贴板。value = clipId（8 位短 id）。 */
export function clipSource(): SearchSource {
  return {
    emptyHint: '标题 / 正文 / 作者片段，或直接粘 8 位 id',
    async initial() {
      const { listAdminClips } = await import('../../src/lib/admin-clipboard-service');
      const r = await listAdminClips({ page: 1, perPage: 20, status: 'all' });
      return r.clips.map((c) => ({
        value: c.id,
        label: c.title,
        hint: `${c.author?.username ?? '—'} · ${c.ignore ? '已删除' : '正常'}${c.publicity ? '' : ' · 私有'}`,
      }));
    },
    async search(q) {
      const { listAdminClips } = await import('../../src/lib/admin-clipboard-service');
      const r = await listAdminClips({ page: 1, perPage: 20, search: q, status: 'all' });
      return r.clips.map((c) => ({
        value: c.id,
        label: c.title,
        hint: `${c.author?.username ?? '—'} · ${c.ignore ? '已删除' : '正常'}${c.publicity ? '' : ' · 私有'}`,
      }));
    },
  };
}

/** 投票。value = voteId（9 位短 id）。 */
export function voteSource(): SearchSource {
  return {
    emptyHint: '标题 / 作者片段，或直接粘 9 位 id',
    async initial() {
      const { listAdminVotes } = await import('../../src/lib/admin-vote-service');
      const r = await listAdminVotes({ page: 1, perPage: 20, status: 'all' });
      return r.votes.map((v) => ({
        value: v.id,
        label: v.title,
        hint: `${v.author?.username ?? '—'} · ${v.ignore ? '已删除' : '正常'} · ${v._count.records} 票`,
      }));
    },
    async search(q) {
      const { listAdminVotes } = await import('../../src/lib/admin-vote-service');
      const r = await listAdminVotes({ page: 1, perPage: 20, search: q, status: 'all' });
      return r.votes.map((v) => ({
        value: v.id,
        label: v.title,
        hint: `${v.author?.username ?? '—'} · ${v.ignore ? '已删除' : '正常'} · ${v._count.records} 票`,
      }));
    },
  };
}

/** 图床图片。value = imageId（10 位短 id）。 */
export function imageSource(): SearchSource {
  return {
    emptyHint: '文件名 / 作者片段，或直接粘 10 位 id',
    async initial() {
      const { listAdminImages } = await import('../../src/lib/admin-image-service');
      const r = await listAdminImages({ page: 1, perPage: 20, status: 'all' });
      return r.images.map((i) => ({
        value: i.id,
        label: i.filename,
        hint: `${i.author?.username ?? '—'} · ${i.ignore ? '已删除' : '正常'}`,
      }));
    },
    async search(q) {
      const { listAdminImages } = await import('../../src/lib/admin-image-service');
      const r = await listAdminImages({ page: 1, perPage: 20, search: q, status: 'all' });
      return r.images.map((i) => ({
        value: i.id,
        label: i.filename,
        hint: `${i.author?.username ?? '—'} · ${i.ignore ? '已删除' : '正常'}`,
      }));
    },
  };
}

/** 待处理申诉。value = 申诉 id（数字，转成字符串）。 */
export function appealSource(status = 'pending'): SearchSource {
  const toChoices = (
    rows: { id: number; status: string; content: string; appellant: { username: string | null } }[]
  ): Choice[] =>
    rows.map((a) => ({
      value: String(a.id),
      label: `#${a.id} ${preview(a.content, 30)}`,
      hint: `${a.appellant.username ?? '—'} · ${a.status}`,
    }));

  return {
    emptyHint: '申诉正文 / 申诉人片段',
    async initial() {
      const { listAppeals } = await import('../../src/lib/admin-appeal-service');
      return toChoices((await listAppeals({ page: 1, status })).items);
    },
    async search(q) {
      const { listAppeals } = await import('../../src/lib/admin-appeal-service');
      const all = (await listAppeals({ page: 1, status })).items;
      const needle = q.toLowerCase();
      return toChoices(
        all.filter(
          (a) =>
            a.content.toLowerCase().includes(needle) ||
            (a.appellant.username ?? '').toLowerCase().includes(needle)
        )
      );
    },
    allowFreeTextFallback: true, // 直接输申诉 id 也放行
  };
}
