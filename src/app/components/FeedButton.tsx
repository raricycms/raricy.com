'use client';

// FeedButton — 文章详情页「读者交互区」的壳层。
//
// 按状态所有权拆分（依据 reports/round3/notes/impl-split.md §3.1 B1）：
//   · 读者写路径（BlogLike / BlogFeed / 收藏）→ BlogReactions；
//   · 作者/管理员写路径（可见性 PATCH / 删除 DELETE / 编辑）→ BlogManageMenu + BlogManageDialogs；
//   · 只读名单投影（点赞者 / 投喂者）→ BlogAudienceDialogs。
// 本文件只保留：对外 props、布局（#read-controls / 返回按钮 / 管理齿轮位置）、
// 移动端断点，以及 overlay 开合（外部点击 / ESC / 焦点归还）的 effect 编排。
// 对外 API 与 DOM 钩子保持不变（e2e 依赖 #read-controls、#admin-manage-btn 等）。

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import type { BlogVisibility } from '@/lib/blog-visibility';
import { decideBackTarget } from '@/lib/navigation-back';
import BlogReactions from './BlogReactions';
import BlogManageMenu from './BlogManageMenu';
import { BlogLikersDialog, BlogFeedersDialog } from './BlogAudienceDialogs';
import { BlogVisibilityDialog, BlogDeleteDialog } from './BlogManageDialogs';

type Overlay = 'menu' | 'likers' | 'feeders' | 'visibility' | 'delete' | 'feed' | null;

interface Props {
  blogId: string;
  blogTitle: string;
  /** 当前登录用户对本文已投喂的累计量（0~5）。未登录传 0。 */
  initialFed?: number;
  /** 文章累计被投喂总量。 */
  initialFishCount: number;
  /** 是否已登录。 */
  isAuth: boolean;
  /** 是否核心用户（可投喂）。 */
  isCore: boolean;
  /** 当前用户是否已点赞。 */
  initialLiked: boolean;
  /** 点赞总数。 */
  initialLikes: number;
  /** 是否显示「管理文章」入口（管理员 或 作者本人）。 */
  canManage: boolean;
  /** 是否作者本人（管理弹窗内显示编辑入口）。 */
  canEdit: boolean;
  /** 管理员删除他人文章（删除需填写原因）。 */
  isAdminDelete: boolean;
  /**
   * 本文当前的可见性档位（作者在「管理文章」里能改它）。
   *
   * **必传，没有默认值** —— 给个 `'internal'` 的兜底会让「调用方忘了传」表现为
   * 「弹窗里显示的档位是错的」：作者看到「仅站内可见」就去点确认，而文章其实早就是
   * 对外公开的。这种「默认值是谎话」的参数正是本仓库反复防的那类静默错。
   */
  initialVisibility: BlogVisibility;
  /**
   * 上次可见性变更，形如「2026-09-19 由「仅站内可见」改为「对外公开」」。从没改过则 null。
   *
   * **由服务端格式化好的整句**（含日期）：客户端组件里做日期格式化会撞上全站禁用的
   * `toLocale*` / 本地 getter（见 `db-time.ts` 与 `db-time-guard`），所以日期留在服务端切。
   */
  lastVisibilityChange?: string | null;
  /** 当前用户的任一收藏夹是否含本文 —— 星标按钮的初始态（未登录传 false）。 */
  initialFavorited?: boolean;
}

export default function FeedButton({
  blogId,
  blogTitle,
  initialFed = 0,
  initialFishCount,
  isAuth,
  isCore,
  initialLiked,
  initialLikes,
  canManage,
  canEdit,
  isAdminDelete,
  initialVisibility,
  lastVisibilityChange = null,
  initialFavorited = false,
}: Props) {
  const router = useRouter();

  // 同一时刻只有一个 overlay：管理目录 / 两个只读名单 / 两个管理弹窗 / 投喂弹窗。
  // 读者与管理写路径的事实状态分别住在 BlogReactions / BlogManageDialogs 里，
  // 这里只管「谁开着」与「怎么关」。
  const [overlay, setOverlay] = useState<Overlay>(null);
  const manageRef = useRef<HTMLDivElement>(null);
  const manageToggleRef = useRef<HTMLButtonElement>(null);
  const [mobileControls, setMobileControls] = useState(false);

  // 与样式的 768px 断点同步：手机端收起的互动胶囊也要退出键盘焦点序列。
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)');
    const sync = () => setMobileControls(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // 管理目录的外部点击收起。
  useEffect(() => {
    if (overlay !== 'menu') return;
    const onOutside = (e: PointerEvent) => {
      if (!manageRef.current?.contains(e.target as Node)) setOverlay(null);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [overlay]);

  // ESC 关闭；从管理视图（含目录）关闭时把焦点还给齿轮，投喂弹窗不抢焦点。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const wasManageView = overlay !== null && overlay !== 'feed';
      setOverlay(null);
      if (wasManageView) manageToggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlay]);

  // 管理弹窗的「取消」：回到「管理文章」目录而非直接关闭，并把焦点还给齿轮。
  function returnToManage() {
    setOverlay('menu');
    requestAnimationFrame(() => manageToggleRef.current?.focus());
  }

  // 「返回上页」：历史记录多于一条时沿用 back()，只有当前页时就
  // 落回一个确定存在的站内列表页 —— 否则 history.back() 是**静默空操作**、按钮成死键。
  // 判据与「为什么不用 document.referrer」见 src/lib/navigation-back.ts。
  function handleBack() {
    const target = decideBackTarget({ historyLength: window.history.length, isCore });
    if (target.kind === 'history-back') window.history.back();
    else router.push(target.href);
  }

  return (
    <>
      {/* 整排随内容宽度居中；手机端展开管理时，互动胶囊同步收缩。 */}
      <div className={`read-controls${overlay === 'menu' ? ' is-manage-open' : ''}`} id="read-controls">
        <div className="read-controls__bar">
          <button onClick={handleBack} className="read-btn" aria-label="返回上页" title="返回上页">
            <ChevronLeft aria-hidden="true" />
          </button>
          <div className="read-controls__interaction" inert={mobileControls && overlay === 'menu'}>
            <BlogReactions
              blogId={blogId}
              isAuth={isAuth}
              isCore={isCore}
              canEdit={canEdit}
              initialLiked={initialLiked}
              initialLikes={initialLikes}
              initialFed={initialFed}
              initialFishCount={initialFishCount}
              initialFavorited={initialFavorited}
              feedOpen={overlay === 'feed'}
              onOpenFeed={() => setOverlay('feed')}
              onCloseFeed={() => setOverlay(null)}
            />
          </div>

          {canManage && (
            <BlogManageMenu
              blogId={blogId}
              open={overlay === 'menu'}
              canEdit={canEdit}
              onToggle={() => setOverlay(overlay === 'menu' ? null : 'menu')}
              onClose={() => setOverlay(null)}
              onOpenView={(view) => setOverlay(view)}
              containerRef={manageRef}
              toggleRef={manageToggleRef}
            />
          )}
        </div>
      </div>

      {canManage && (
        <BlogLikersDialog blogId={blogId} open={overlay === 'likers'} onClose={() => setOverlay(null)} />
      )}
      {canManage && (
        <BlogFeedersDialog blogId={blogId} open={overlay === 'feeders'} onClose={() => setOverlay(null)} />
      )}
      {canEdit && (
        <BlogVisibilityDialog
          blogId={blogId}
          initialVisibility={initialVisibility}
          lastVisibilityChange={lastVisibilityChange}
          open={overlay === 'visibility'}
          onClose={() => setOverlay(null)}
          onReturnToManage={returnToManage}
        />
      )}
      {canManage && (
        <BlogDeleteDialog
          blogId={blogId}
          blogTitle={blogTitle}
          isAdminDelete={isAdminDelete}
          open={overlay === 'delete'}
          onClose={() => setOverlay(null)}
          onReturnToManage={returnToManage}
        />
      )}
    </>
  );
}
