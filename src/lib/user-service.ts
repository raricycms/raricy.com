// ─────────────────────────────────────────────────────────────────────────────
// user-service.ts — 用户公开资料 / 本人资料更新。
//
// 从原 user-service.ts 按状态所有权拆出（依据 reports/round3/notes/impl-split.md §3.2 B2）：
//   · 本文件唯一负责的事实：`users.bio`、隐私可见性、通知偏好、专注屏蔽大区；
//   · 账号/凭据事实（password_hash / role 邀请码升级 / session_version / InviteCode
//     核销）在 account-service.ts。
// 两边的列不重叠、依赖集不相交；`ProfileViewer` 只被公开资料读路径使用。
//
// 与其它 service 一致：纯函数 + 显式参数，方便测试与复用。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { frameUrlFor } from './frame-service';
import { kickUser } from './chat-bus';
import { publishToUser } from './topbar-bus';
import {
  isFocusLobbyBlocked,
  parseFocusHiddenCategories,
  parseFocusHiddenCategoriesInput,
  serializeFocusHiddenCategories,
} from './focus-mode';
import type { Prisma } from '@prisma/client';

// ── 公开资料 ────────────────────────────────────────────────────────────────

/**
 * 把 `/api/users/<句柄>` 的句柄解析成用户 id，并说明是**按 id 还是按用户名**命中的。
 * 两边都没有返回 null。
 *
 * 【为什么要「按名字」这条路】用户名片 `[@用户/张三]` 只带用户名（可读、能手打，且
 * 用户名在本站不可改），而 `getPublicProfile` 只认 id。
 *
 * 【为什么不是「拿 UUID 正则去认形态」】那等于假设 id 一定是 UUID —— 而这是个**没写在
 * 任何地方的不变量**，存量数据、测试夹具、将来的迁移都可能给出别的形态（bot 文档里
 * 那个 `u_xxx` 的例子就是这么来的）。以「实际命中了哪一列」为准就没有这个假设。
 * 代价是名字那条路多一次索引查询，而它背后本来就跟着一次 5 分钟缓存（见
 * src/app/components/useUserCards.ts）。
 *
 * 【id 优先】两列都命中时（理论上只有形态奇特的存量 id 才可能）id 赢，结果是确定的。
 * 换过来写会得到一个「同一串字符时而按人、时而按名字解析」的接口。
 *
 * ⚠️ 用户名**唯一但大小写敏感**（`ZhangSan` 与 `zhangsan` 是两个不同的号），所以这里
 * 不做任何归一化 —— 归一化会把两个不同的用户折叠成同一个，而那是**静默**的。
 */
export async function resolveProfileHandle(
  handle: string
): Promise<{ id: string; viaName: boolean } | null> {
  const byId = await prisma.user.findUnique({ where: { id: handle }, select: { id: true } });
  if (byId) return { id: byId.id, viaName: false };
  const byName = await prisma.user.findUnique({
    where: { username: handle },
    select: { id: true },
  });
  return byName ? { id: byName.id, viaName: true } : null;
}

/** 查看者。`null` = 游客（未登录），**不是**「不判」。 */
export interface ProfileViewer {
  id: string;
  isCore: boolean;
}

export interface PublicProfile {
  id: string;
  username: string;
  avatarPath: string | null;
  /**
   * 头像框贴图地址；null = 没戴 / 已过期 / 素材缺失。**判定已在服务层做完**
   *（到期判定只在 frame-service.frameUrlFor 一处，见那里的文件头）。
   *
   * 【对外可读性】框是**站点素材**，不是用户的站内信息 —— 与 `role` 不同，
   * 它不需要按查看者档位收敛（档位不足时 `role` 为 null，而框照样给）。
   */
  frameUrl: string | null;
  bio: string | null;
  createdAt: string | null;
  /** 档位不足时**为 null** —— 别拿它当「一定有」。渲染前必须挡空。 */
  role: string | null;
  showRecentBlogs: boolean;
  showRecentComments: boolean;
  recentBlogs: { id: string; title: string; createdAt: string | null; likesCount: number }[];
  recentComments: {
    id: string;
    blogId: string;
    blogTitle: string;
    content: string;
    createdAt: string | null;
  }[];
}

/**
 * 对外公开资料（无 email）。**内容按查看者分档**，不存在返回 null。
 *
 * 【为什么不给 viewer 默认值】照 `clipboard-service.getClip` 的纪律：**默认放行的参数
 * 一旦漏传就是越权**。所以 viewer 必传 —— 调用方要么给 `null`（游客），要么把登录态
 * 显式算出来传进来，不能靠「不写就自动放行」。
 *
 * 【分档口径】`/u/:id` 是**匿名可达**的页面（主页画报的二维码会把站外人引到这里），
 * 所以 profile 里能对游客露什么必须逐项想清楚：
 *   · 一律可见：username / avatarPath / bio / createdAt + 两个开关的当前值（那是页面的主体）
 *   · 仅本人或 core+ 可见：role 徽章、recentBlogs、recentComments
 * 后者三项此前对全互联网开着 —— 而「最后登录时间」还不在本函数里，由 `src/app/u/[id]/page.tsx`
 * 单独查，同样要按查看者收（连同统计行的计数与文章/评论标签区）。
 *
 * 注意两个开关（showRecentBlogs / showRecentComments）**照旧生效**，它们管的是「本人
 * 愿不愿意展示」，与「查看者够不够格」是两个正交的问题：两边都放行才看得见。
 */
export async function getPublicProfile(
  userId: string,
  viewer: ProfileViewer | null
): Promise<PublicProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      avatarPath: true,
      bio: true,
      createdAt: true,
      role: true,
      showRecentBlogs: true,
      showRecentComments: true,
      equippedFrameKey: true,
      equippedFrameExpiresAt: true,
    },
  });
  if (!user) return null;

  // 本人看自己永远放行（否则「我的主页」会因为我只是 role=user 就变空壳）；
  // 其余人按档位：core+ 放行，游客与非 core 只拿到上面那几项身份字段。
  const isSelf = viewer?.id === user.id;
  const canSeeContent = isSelf || viewer?.isCore === true;

  const recentBlogs = canSeeContent && user.showRecentBlogs
    ? await prisma.blog.findMany({
        where: { authorId: user.id, ignore: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, title: true, createdAt: true, likesCount: true },
      })
    : [];

  // ⚠️ anonSeq: null —— **匿名评论不进个人主页**。
  // 主页是 core+ 都能看的，而 core+ 正是会去评论区的那群人：把条目列在这里，
  // 读者拿正文一比对就把他和评论区里的化名对上号了 —— 匿名承诺当场作废。
  // 代价是他自己也看不到（同一份查询同时服务本人与访客），这是**刻意**的：
  // 一份按查看者分叉的查询比「少几条」更容易在某次改动里把口径弄反。
  const recentComments = canSeeContent && user.showRecentComments
    ? await prisma.blogComment.findMany({
        where: { authorId: user.id, isDeleted: false, anonSeq: null, blog: { ignore: false } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          blogId: true,
          content: true,
          createdAt: true,
          blog: { select: { title: true } },
        },
      })
    : [];

  return {
    id: user.id,
    username: user.username,
    avatarPath: user.avatarPath,
    // 框不跟着 canSeeContent 收敛：它是站点素材，不是这个人的站内信息（见类型上的注释）
    frameUrl: frameUrlFor(user),
    bio: user.bio,
    createdAt: user.createdAt ? user.createdAt.toISOString() : null,
    role: canSeeContent ? user.role : null,
    showRecentBlogs: user.showRecentBlogs,
    showRecentComments: user.showRecentComments,
    recentBlogs: recentBlogs.map((b) => ({
      id: b.id,
      title: b.title,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
      likesCount: b.likesCount ?? 0,
    })),
    recentComments: recentComments.map((c) => ({
      id: c.id,
      blogId: c.blogId,
      blogTitle: c.blog?.title ?? '',
      content: (c.content ?? '').slice(0, 120),
      createdAt: c.createdAt ? c.createdAt.toISOString() : null,
    })),
  };
}

// ── 本人资料更新 ──────────────────────────────────────────────────────────────

export interface ProfilePatch {
  bio?: string | null;
  notifyLike?: boolean;
  notifyEdit?: boolean;
  notifyDelete?: boolean;
  notifyAdmin?: boolean;
  showRecentBlogs?: boolean;
  showRecentComments?: boolean;
  /** 专注模式总开关（账号级浏览偏好，见 schema User.focusMode） */
  focusMode?: boolean;
  /** 专注模式子项：是否屏蔽讨论大区 / 玩具区 / 鱼干练手盘 */
  focusBlockLobby?: boolean;
  focusBlockGames?: boolean;
  focusBlockFishTrade?: boolean;
  /**
   * 专注模式要屏蔽的博客栏目 id。
   * `null` = 恢复站长默认集合；数组（含 `[]`）= 用户显式选择。
   */
  focusHideCategories?: number[] | null;
}

export interface UpdateResult {
  ok: boolean;
  code: number;
  message: string;
  data?: ProfilePatch;
}

/** 更新本人资料（仅传入的字段）。bio ≤ 500 字，超长拒绝（对齐 update_bio）。 */
export async function updateOwnProfile(userId: string, patch: ProfilePatch): Promise<UpdateResult> {
  const data: Prisma.UserUpdateInput = {};

  if ('bio' in patch) {
    const bio = (patch.bio ?? '').toString().trim();
    if (bio.length > 500) {
      return { ok: false, code: 400, message: '个人简介不能超过 500 字' };
    }
    data.bio = bio ? bio : null;
  }
  if (typeof patch.notifyLike === 'boolean') data.notifyLike = patch.notifyLike;
  if (typeof patch.notifyEdit === 'boolean') data.notifyEdit = patch.notifyEdit;
  if (typeof patch.notifyDelete === 'boolean') data.notifyDelete = patch.notifyDelete;
  if (typeof patch.notifyAdmin === 'boolean') data.notifyAdmin = patch.notifyAdmin;
  if (typeof patch.showRecentBlogs === 'boolean') data.showRecentBlogs = patch.showRecentBlogs;
  if (typeof patch.showRecentComments === 'boolean') {
    data.showRecentComments = patch.showRecentComments;
  }
  if (typeof patch.focusMode === 'boolean') data.focusMode = patch.focusMode;
  if (typeof patch.focusBlockLobby === 'boolean') data.focusBlockLobby = patch.focusBlockLobby;
  if (typeof patch.focusBlockGames === 'boolean') data.focusBlockGames = patch.focusBlockGames;
  if (typeof patch.focusBlockFishTrade === 'boolean') {
    data.focusBlockFishTrade = patch.focusBlockFishTrade;
  }
  if ('focusHideCategories' in patch) {
    // 严格解析请求体：非法形状必须报错，不能静默回落成「默认集合」——
    // 用户点了保存却没生效是静默失效，比 400 难查得多。
    const parsed = parseFocusHiddenCategoriesInput(patch.focusHideCategories);
    if (!parsed.ok) {
      return { ok: false, code: 400, message: '专注模式屏蔽栏目格式错误' };
    }
    data.focusHideCategories =
      parsed.value === null ? null : serializeFocusHiddenCategories(parsed.value);
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, code: 400, message: '没有可更新的字段' };
  }

  // 文案按本次实际改了什么来选（两句话都沿用既有措辞，别改）：
  // 只动隐私/通知开关 → 「隐私设置已保存」；只要动了 bio → 「资料已保存」。
  const touchedBio = 'bio' in data;
  const savedMessage = touchedBio ? '资料已保存' : '隐私设置已保存';

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      bio: true,
      notifyLike: true,
      notifyEdit: true,
      notifyDelete: true,
      notifyAdmin: true,
      showRecentBlogs: true,
      showRecentComments: true,
      focusMode: true,
      focusHideCategories: true,
      focusBlockLobby: true,
      focusBlockGames: true,
      focusBlockFishTrade: true,
    },
  });

  // 专注模式变更 → 踢掉已建立的讨论 SSE 连接：重连时按新值决定是否接收大区推送
  // （chat-bus 按连接建立时的 lobbyBlocked 过滤大区广播）。
  //
  // 只有**影响大区可见性**的两列（总开关 / 大区子项）需要踢；改玩具区、练手盘或
  // 博客栏目不动讨论流 —— 无差别踢一次会让所有人保存任何子项都断流重连。
  if ('focusMode' in data || 'focusBlockLobby' in data) {
    kickUser(userId);
    // 顶栏红点同样受大区可见性影响（大区被屏蔽时不计入汇总）。这里**不踢顶栏流**：
    // 会话没废，铃铛照常要收推送。推送值分两种（够不着 chat-service，会成环，
    // 见 topbar-bus 的 TopbarPatch）：大区被屏蔽 → 必为 false，推精确值；
    // 解除屏蔽 → 大区里可能还压着 @ 我的未读，推「重算」让客户端走 count 路由。
    publishToUser(
      userId,
      isFocusLobbyBlocked(updated) ? { chatUnread: false } : { refresh: true }
    );
  }

  return {
    ok: true,
    code: 200,
    message: savedMessage,
    data: {
      bio: updated.bio,
      notifyLike: updated.notifyLike ?? true,
      notifyEdit: updated.notifyEdit ?? true,
      notifyDelete: updated.notifyDelete ?? true,
      notifyAdmin: updated.notifyAdmin ?? true,
      showRecentBlogs: updated.showRecentBlogs,
      showRecentComments: updated.showRecentComments,
      focusMode: updated.focusMode,
      focusBlockLobby: updated.focusBlockLobby,
      focusBlockGames: updated.focusBlockGames,
      focusBlockFishTrade: updated.focusBlockFishTrade,
      focusHideCategories: parseFocusHiddenCategories(updated.focusHideCategories),
    },
  };
}
