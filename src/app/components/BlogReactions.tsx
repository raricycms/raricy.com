'use client';

// BlogReactions — 文章详情页「读者写路径」：点赞 / 投喂 / 收藏。
//
// 事实归属（见 impl-split.md B1）：
//   · BlogLike 行 + 点赞数：唯一写者是 POST /api/blogs/:id/like（blog-service.toggleLike）；
//   · BlogFeed 行 + 投喂总数 + 本人已投（≤ FEED_CAP）：唯一写者是
//     POST /api/blogs/:id/feed（feed-service.feedBlog，事务 + 通知后置）；
//   · 收藏：由 FavoriteButton 自己持有，本组件只负责摆位置。
//
// 作者/管理员写路径（可见性 / 删除 / 编辑）在 BlogManageMenu / BlogManageDialogs，
// 只读名单投影（点赞者 / 投喂者）在 BlogAudienceDialogs —— 不在这里。
// 壳层 FeedButton 只保留布局、返回按钮、overlay 开合与 effect 编排。

import { useEffect, useState } from 'react';
import FavoriteButton from './FavoriteButton';

const FEED_CAP = 5;

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

function ReadCount({ count, id, className }: { count: number; id: string; className: string }) {
  const visible = count > 0;
  const [lastCount, setLastCount] = useState(count);

  // 收回时保留上一枚数字供淡出；零值不占宽度，也不进入辅助技术的读数。
  useEffect(() => {
    if (count > 0) setLastCount(count);
  }, [count]);

  return (
    <span
      className={`read-count numeric${visible ? ' read-count--visible' : ''}`}
      style={{ width: visible ? `calc(${String(count).length}ch + 6px)` : '0px' }}
      aria-hidden={!visible}
    >
      <span className={className} id={visible ? id : undefined}>
        {visible ? count : lastCount || ''}
      </span>
    </span>
  );
}

interface Props {
  blogId: string;
  /** 是否已登录。 */
  isAuth: boolean;
  /** 是否核心用户（可投喂）。 */
  isCore: boolean;
  /** 是否作者本人（作者不能给自己的文章投喂）。 */
  canEdit: boolean;
  /** 当前用户是否已点赞。 */
  initialLiked: boolean;
  /** 点赞总数。 */
  initialLikes: number;
  /** 当前登录用户对本文已投喂的累计量（0~5）。未登录传 0。 */
  initialFed?: number;
  /** 文章累计被投喂总量。 */
  initialFishCount: number;
  /** 当前用户的任一收藏夹是否含本文 —— 星标按钮的初始态（未登录传 false）。 */
  initialFavorited?: boolean;
  /** 投喂弹窗的开合由壳层 overlay 编排。 */
  feedOpen: boolean;
  onOpenFeed: () => void;
  onCloseFeed: () => void;
}

export default function BlogReactions({
  blogId,
  isAuth,
  isCore,
  canEdit,
  initialLiked,
  initialLikes,
  initialFed = 0,
  initialFishCount,
  initialFavorited = false,
  feedOpen,
  onOpenFeed,
  onCloseFeed,
}: Props) {
  // ── 点赞 ────────────────────────────────────────────────────────────────────
  const [liked, setLiked] = useState(initialLiked);
  const [likes, setLikes] = useState(initialLikes);
  const [likeBusy, setLikeBusy] = useState(false);

  async function handleLike() {
    if (!isAuth) {
      toast('请先登录后再点赞', 'info');
      window.location.href = '/login';
      return;
    }
    setLikeBusy(true);
    try {
      const res = await fetch(`/api/blogs/${blogId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setLiked(!!data.liked);
        setLikes(data.likes_count);
        toast(data.liked ? '已点赞' : '已取消点赞', data.liked ? 'success' : 'info');
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setLikeBusy(false);
    }
  }

  // ── 投喂 ────────────────────────────────────────────────────────────────────
  const [fed, setFed] = useState(initialFed);
  const [fishCount, setFishCount] = useState(initialFishCount);
  const [selected, setSelected] = useState(0);
  const [feedStatus, setFeedStatus] = useState('');
  const [feedBusy, setFeedBusy] = useState(false);
  const remaining = Math.max(0, FEED_CAP - fed);

  function openFeedModal() {
    if (canEdit) return;
    if (!isAuth) {
      window.location.href = '/login';
      return;
    }
    if (!isCore) {
      toast('仅核心用户可投喂小鱼干', 'warning');
      return;
    }
    if (fed >= FEED_CAP) {
      toast('已投满 5 条，不能再投了', 'info');
      return;
    }
    setSelected(0);
    setFeedStatus(`已投 ${fed}/5，还可投喂 ${remaining} 条`);
    onOpenFeed();
  }

  function selectAmount(n: number) {
    setSelected(n);
    setFeedStatus(`已投 ${fed}/5，投喂 ${n} 条`);
  }

  async function doFeed() {
    if (selected <= 0 || feedBusy) return;
    const amount = selected;
    setFeedBusy(true);
    setFeedStatus('投喂中...');
    try {
      const res = await fetch(`/api/blogs/${blogId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (data.code === 200) {
        setFed(data.fed_total ?? fed + amount);
        setFishCount(data.fish_count ?? fishCount + amount);
        onCloseFeed();
        toast(`投喂成功！消耗 ${amount} 条小鱼干`, 'success');
      } else {
        toast(data.message || '投喂失败', 'error');
        setFeedStatus(`已投 ${fed}/5，投喂 ${amount} 条`);
      }
    } catch {
      toast('网络错误，请重试', 'error');
    } finally {
      setFeedBusy(false);
    }
  }

  return (
    <>
      <div className="read-controls__row">
        <button
          id="like-btn"
          className={`like-btn${liked ? ' liked' : ''}`}
          onClick={handleLike}
          disabled={likeBusy}
          aria-label="点赞"
          aria-pressed={liked}
          title={liked ? '已点赞' : '点赞'}
        >
          <span className="icon icon-heart-fill" aria-hidden="true"></span>
          <ReadCount count={likes} id="like-count" className="like-count-badge" />
        </button>

        <button
          id="feed-fish-btn"
          className={`fish-btn${fed > 0 ? ' fish-btn--fed' : ''}`}
          onClick={openFeedModal}
          disabled={canEdit || (isAuth && fed >= FEED_CAP)}
          title={canEdit ? '不能给自己的文章投喂' : '投喂小鱼干'}
          aria-label={canEdit ? '收到的投喂' : '投喂小鱼干'}
        >
          <span className="icon icon-fish" aria-hidden="true"></span>
          <ReadCount count={fishCount} id="fish-count" className="fish-count-badge" />
        </button>

        {/* 收藏夹（黄色五角星）。刻意**不带计数徽标** —— 站内不显示被收藏数。
            组件自带选择器弹窗；对所有人渲染，档位判断在组件内做。 */}
        <FavoriteButton
          blogId={blogId}
          isAuth={isAuth}
          isCore={isCore}
          initialFavorited={initialFavorited}
        />
      </div>

      {/* 小鱼干投喂弹窗（两步式：选数量 → 确认）*/}
      <div className={`feed-modal${feedOpen ? ' feed-modal--open' : ''}`} id="feedModal">
        <div className="feed-modal__backdrop" onClick={onCloseFeed} />
        <div className="feed-modal__content">
          <div className="feed-modal__header">
            <h3><span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>投喂小鱼干</h3>
            <p className="numeric" id="feedModalStatus">{feedStatus}</p>
          </div>
          <div className="feed-modal__buttons" id="feedButtons">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`numeric feed-modal__amount-btn${selected === n ? ' feed-modal__amount-btn--selected' : ''}`}
                data-amount={n}
                onClick={() => selectAmount(n)}
                disabled={feedBusy || n > remaining}
              >
                {n} 条
              </button>
            ))}
          </div>
          <div className="feed-modal__actions">
            <button className="feed-modal__close-btn" id="feedCancelBtn" onClick={onCloseFeed}>
              取消
            </button>
            <button
              className="feed-modal__confirm-btn"
              id="feedConfirmBtn"
              onClick={doFeed}
              disabled={selected <= 0 || feedBusy}
            >
              确认投喂
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
