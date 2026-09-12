'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LS_KEY, COOKIE_NAME, COOKIE_MAX_AGE } from '@/lib/blog-sort-pref';

// 博客列表排序切换 —「发布时间 / 更新时间」
//
// 【三层决策链，服务端与客户端同源】URL 显式合法 sort > cookie=updated > created(默认)。
// 列表排序由 page.tsx 的 effectiveSort 决定（URL 显式 ?? cookie ?? created），并作为
// initialSort prop 传回本组件作选中态兜底 —— 高亮与列表序来自同一次服务端渲染，
// 任何一帧都一致，不存在「首帧 created、水合后翻 updated」的跳变。
//
// 【偏好存储分两处，职责不同】
//  - localStorage（LS_KEY，长命记忆）：只在「URL 无 sort 参数且无 cookie」时兜底迁移。
//  - cookie（COOKIE_NAME，SSR 可见镜像）：页面首个 document.cookie 写入点 ——
//    非 httpOnly 是刻意选择：effect 要读它判断是否迁移。SSR 首屏读 cookie 直出排序，
//    是消除跳变的关键；cookie 在无 cookie 旧访客路径上由下方 effect 从 LS 补建。
//    一年期；Safari ITP 可能压短，届时 LS 迁移自愈。created 态不存值（删除 cookie），
//    与「默认 created 用无参 URL」的最小化风格一致。
//
// 【两条免翻转保证】
//  1. 服务端把 URL 里显式合法的 sort 回显到页内链接（侧栏/搜索/分页），见 page.tsx /
//     BlogSidebar / SearchForm —— 从已选 updated 的页面点出去的跳转都带着 sort。
//     无参 URL 的偏好则由 cookie 在服务端直接生效，回显缝隙（如侧栏子分类）不再需要
//     客户端补参。
//  2. 迁移 effect（下方）：仅当 URL 无 sort 参数 且 cookie 缺失（旧访客的 localStorage
//     存量 / cookie 被 ITP 清掉后的自愈）且 LS 偏好是 updated → 写 cookie 并 replace 补
//     sort=updated。cookie 已存在即稳态，SSR 首帧已正确 —— 绝不 replace，省一次整页重取。
//
// 排序改变意味着页内序号失效，切换时删掉 page 参数回第 1 页。
// localStorage 只在 useEffect 里读，不会造成 hydration 失配。
import type { BlogSort as SortValue } from '@/lib/blog-service';

/** 读取 cookie 镜像是否已写入（存在即稳态，取值只可能是 updated）。 */
function hasCookie(): boolean {
  try {
    return document.cookie.split('; ').some((c) => c.startsWith(`${COOKIE_NAME}=`));
  } catch {
    return false;
  }
}

/** 写/删 cookie 镜像：updated 写入一年期；created 是默认态，删除不存值。 */
function writeCookie(v: SortValue) {
  try {
    document.cookie =
      v === 'updated'
        ? `${COOKIE_NAME}=updated; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
        : `${COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`;
  } catch {
    // cookie 不可用（被禁）→ 放弃镜像，LS 迁移 effect 每次进入兜底，行为同旧版
  }
}

/** 读取记忆偏好：只认 created/updated，其余（缺省/脏值/隐私模式异常）一律视为 created。 */
function readPref(): SortValue {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'updated') return 'updated';
  } catch {
    // localStorage 不可用（隐私模式/被禁）→ 放弃记忆，按默认行为走
  }
  return 'created';
}

function writePref(v: SortValue) {
  try {
    localStorage.setItem(LS_KEY, v);
  } catch {
    // 同上：写失败不阻断排序切换
  }
}

export default function BlogSort({ initialSort }: { initialSort: SortValue }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 选中态 = URL 显式合法 sort（导航后自动跟上）> 服务端 initialSort（同帧同源，水合安全）。
  // 非法值/缺省视同 created —— initialSort 兜底时已含 cookie 偏好，故无需再读 URL 之外的状态。
  const urlSort = searchParams.get('sort');
  const selected: SortValue =
    urlSort === 'created' || urlSort === 'updated' ? urlSort : initialSort;

  // 迁移：URL 无 sort 参数 + 无 cookie（旧访客存量 LS / ITP 清 cookie 后自愈）+ LS=updated
  // → 补建 cookie 镜像并 replace 补参（补参后 effect 再跑即有显式 sort → 自终止，无循环）。
  // cookie 已存在 = 稳态，SSR 首屏已按偏好直出 —— 提前 return，不 replace、不重取数。
  useEffect(() => {
    if (searchParams.get('sort') !== null) return;
    if (hasCookie()) return;
    if (readPref() !== 'updated') return;
    writeCookie('updated');
    const p = new URLSearchParams(searchParams.toString());
    p.set('sort', 'updated');
    router.replace(`?${p.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function choose(next: SortValue) {
    // 存储无条件先行同步：点「已激活项」的 no-nav 分支也要收敛 cookie/LS
    // （清掉 ?sort=created + cookie=updated 这类冲突态），并顺带给 cookie 续期。
    writePref(next);
    writeCookie(next);
    if (next === selected) return;
    const p = new URLSearchParams(searchParams.toString());
    if (next === 'updated') {
      p.set('sort', 'updated');
    } else {
      p.delete('sort'); // 默认态以无参为最小 URL
    }
    p.delete('page'); // 排序语义变了，第 N 页的序号失效，回第 1 页
    // 目标与当前完全相同（cookie 稳态的无参页上点「发布时间」：只删了 cookie，
    // URL 无参可删）→ router.push 对同 URL 会 no-op，必须 refresh 让服务端按已删
    // cookie 重出 created 序。
    if (p.toString() === searchParams.toString()) router.refresh();
    else router.push(`?${p.toString()}`);
  }

  return (
    <div className="blog-sort" role="group" aria-label="博客排序方式">
      <button
        type="button"
        className={`blog-sort-btn${selected === 'created' ? ' active' : ''}`}
        aria-pressed={selected === 'created'}
        onClick={() => choose('created')}
      >
        发布时间
      </button>
      <button
        type="button"
        className={`blog-sort-btn${selected === 'updated' ? ' active' : ''}`}
        aria-pressed={selected === 'updated'}
        onClick={() => choose('updated')}
      >
        更新时间
      </button>
    </div>
  );
}
