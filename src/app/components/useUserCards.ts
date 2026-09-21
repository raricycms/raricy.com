'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useUserCards.ts — 把正文里的 `[@用户/<用户名>]` 解析成名片数据
//
// 【为什么异步留在 React 层】与 useResolvedContent.ts 的文件头逐字同源：净化管线
// （src/lib/rich-text.ts）是**同步**的，改成 async 会把整个讨论区 / 评论区翻成状态机。
// 所以取数只留在这里，取到之后当一份普通数据交给渲染器，渲染器本身仍然又纯又可缓存。
//
// 【扫的是**原始正文**，不是剪贴板展开后的正文】`[@用户/张三]` 也可能出现在被引用的
// 剪贴板正文里 —— 那是**别人写的**文本，不该在我们这条消息里被二次展开。这与
// content-refs.ts 的 replaceClipboardRef「按区间切片、不重扫整串」是同一笔账。
//
// 【加载中 / 取不到显示什么】就显示字面量 `[@用户/张三]`。这是唯一既不跳版、又不需要
// 额外「加载态语法」的选择（与剪贴板那条的既有口径一致）；而且「查无此人」与「还没
// 取到」长得一样，正是我们要的 —— 名字打错的人看到的是一段可读的原文，不是报错。
//
// 【缓存】模块级：同一个人被 N 条消息引用时只请求一次；长会话滚动也不会无界增长
// （FIFO + TTL）。**查不到也进缓存**，理由见 cache 的注释。
//
// 【为什么还要 TTL】名片里唯一会变的是**头像框**（换框 / 到期 / 卸下）。永久缓存会让
// 「他换了框」一直持续到刷新页面为止。5 分钟与剪贴板那条同值。
// （头像位图本身不在此列：它的地址恒为 /api/avatar/<id>，换图由浏览器自己的缓存管。）
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { collectUserCardNames, type UserCardData } from '@/lib/user-refs';

/** 缓存条数上限（与 useResolvedContent 同量级即可）。 */
const CACHE_MAX = 200;
/** 缓存有效期：名片的可变部分（头像框）不会秒变，5 分钟足够新。 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * 缓存里**连 null 一起存**（「查无此人 / 无权限」也占一个位置）—— 这一点与剪贴板那条
 * 刻意不同，那边失败不进缓存。
 *
 * 理由是两种失败的性质不一样：剪贴板的失败多半是**瞬时**的（接口抖了一下），所以要
 * 重试；而这里的失败绝大多数是**确定性**的（名字打错、账号不存在、对方非 core+），
 * 重试只是把同一个 404 再打一遍 —— 而讨论列表每挂载一次就会重打一次。
 * 「瞬时的那些」另有判据：网络层抛错与 5xx **不进缓存**（见 loadCard）。
 */
const cache = new Map<string, { card: UserCardData | null; at: number }>();
/** 并发去重：同一个人被多条消息同时引用时只发一次请求。 */
const inflight = new Map<string, Promise<UserCardData | null>>();

/** 命中返回名片（可能是 null），未命中/过期返回 undefined。 */
function readCache(name: string): UserCardData | null | undefined {
  const hit = cache.get(name);
  if (hit === undefined) return undefined;
  // 纯客户端缓存的新鲜度判断：两边都是真实时钟，与库内「UTC+8 墙上时间」无关
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(name);
    return undefined;
  }
  return hit.card;
}

function writeCache(name: string, card: UserCardData | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(name, { card, at: Date.now() });
}

/** 接口载荷 → 名片数据。形状不认就返回 null（宁可少画一张，也不要半个坏节点）。 */
function parseCard(raw: unknown): UserCardData | null {
  const user = (raw as { user?: unknown } | null)?.user;
  if (!user || typeof user !== 'object') return null;
  const { id, username, frameUrl } = user as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof username !== 'string' || !username) return null;
  // 框的判定（到期 / 素材缺失）已在服务层做完（frameUrlFor），这里只做形状收敛 ——
  // 渲染层一次都不比较时间（见 frame-service 的文件头）。
  return { id, username, frameUrl: typeof frameUrl === 'string' ? frameUrl : null };
}

/**
 * 按名字取一张名片。查无此人 / 无权限 / 网络失败一律回落成 null，且不抛。
 *
 * 【为什么名字要编码】用户名允许中文（`[@用户/张三丰]`），不编码会让这一段的字节
 * 直接进 URL；`USER_REF_RE` 的白名单已排除 `/`、`%`、`?`、`#`，所以编码是安全的。
 */
function loadCard(name: string): Promise<UserCardData | null> {
  // ① 命中缓存（含「查无此人」那条负缓存）直接给，不发请求
  const cached = readCache(name);
  if (cached !== undefined) return Promise.resolve(cached);
  // ② 同一个名字正在路上 → 搭同一班车
  const existing = inflight.get(name);
  if (existing) return existing;

  const task = (async () => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
      });
      // 401/403/404 一视同仁：都只是「这张名片画不出来」。
      // 4xx 是**确定性**答复（查无此人 / 没资格），进负缓存；5xx 当瞬时故障，下次重试。
      if (!res.ok) {
        if (res.status < 500) writeCache(name, null);
        return null;
      }
      const card = parseCard(await res.json());
      writeCache(name, card);
      return card;
    } catch {
      // 网络层失败（fetch 抛 / 响应不是 JSON）：**不进缓存**，下次挂载重试
      return null;
    } finally {
      inflight.delete(name);
    }
  })();

  inflight.set(name, task);
  return task;
}

/**
 * 正文里的名片数据：用户名 → 卡片。
 *
 * 返回的 Map **引用稳定**（同样一批名字不会每次渲染都换一个新对象）—— 调用方要拿它
 * 当 useMemo 的依赖，新引用会让整条渲染管线每次重算。
 *
 * 没有名片、或还没取到时返回 undefined（此时渲染器把 token 当字面量）。
 */
export function useUserCards(content: string): Map<string, UserCardData> | undefined {
  const names = useMemo(() => collectUserCardNames(content), [content]);
  // 用 JSON 做键：比 join 分隔符少一个「分隔符恰好出现在名字里」的假设。
  // 它只用来做**竞态守卫**（正文换成另一批名字时，旧结果不能套上去），不参与请求。
  const key = useMemo(() => JSON.stringify(names), [names]);
  const [loaded, setLoaded] = useState<{ key: string; cards: Map<string, UserCardData> } | null>(
    null
  );

  useEffect(() => {
    if (names.length === 0) return;
    let cancelled = false;

    void Promise.all(
      names.map((name) => loadCard(name).then((card) => [name, card] as const))
    ).then((pairs) => {
      if (cancelled) return;
      const cards = new Map<string, UserCardData>();
      for (const [name, card] of pairs) if (card) cards.set(name, card);
      setLoaded({ key, cards });
    });
    return () => {
      cancelled = true;
    };
  }, [names, key]);

  // 竞态守卫：正文换成了另一批名字时，旧的那份不能套用在新正文上
  return loaded && loaded.key === key ? loaded.cards : undefined;
}
