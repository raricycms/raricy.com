'use client';

// FeedButton — 文章详情页「读者交互区」。对齐 Flask 三个组件的可见/可交互形态：
//   • like_system：.read-controls（点赞按钮 + 🐟投喂触发按钮 + 返回上页）
//   • feed_fish_system：两步式投喂弹窗（选数量 → 确认），由投喂按钮触发
//   • admin_controls + modal_system：管理员/作者可见的「查看点赞者/投喂者/编辑/删除」
//     及对应模态框（点赞者列表 / 投喂者列表 / 删除确认）
//
// 由 blog/[id]/page.tsx 挂载。点赞 → POST /api/blogs/:id/like；投喂 → POST /api/blogs/:id/feed。

import { useCallback, useEffect, useState } from 'react';

const FEED_CAP = 5;

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface LikerRow {
  id: string;
  username: string;
  avatar_url?: string | null;
}
interface FeederRow {
  user_id: string;
  username: string;
  amount: number;
  avatar_path?: string | null;
}

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
  /** 是否显示管理区（管理员 或 作者本人）。 */
  canManage: boolean;
  /** 是否作者本人（显示编辑入口）。 */
  canEdit: boolean;
  /** 管理员删除他人文章（删除需填写原因）。 */
  isAdminDelete: boolean;
  /** 单篇文章版权声明，注入页脚 .footer-copy（对齐 Flask block copyright）。 */
  footerCopyright?: string;
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
  footerCopyright,
}: Props) {
  // 单篇文章版权声明注入页脚 .footer-copy（对齐 Flask blog.html 的 {% block copyright %}，
  // 替换默认「© 2026 聪明山」）。共享 Footer 组件不可改，故挂载时改写、卸载时还原。
  useEffect(() => {
    if (!footerCopyright) return;
    const el = document.querySelector<HTMLElement>('.footer-copy');
    if (!el) return;
    const prev = el.textContent;
    el.textContent = footerCopyright;
    return () => {
      el.textContent = prev;
    };
  }, [footerCopyright]);

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
  const [feedOpen, setFeedOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [feedStatus, setFeedStatus] = useState('');
  const [feedBusy, setFeedBusy] = useState(false);
  const remaining = Math.max(0, FEED_CAP - fed);

  function openFeedModal() {
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
    setFeedOpen(true);
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
        setFeedOpen(false);
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

  // ── 模态框（点赞者 / 投喂者 / 删除确认）─────────────────────────────────────
  type ModalKind = 'likers' | 'feeders' | 'delete' | null;
  const [modal, setModal] = useState<ModalKind>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModal(null);
        setFeedOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 点赞者列表
  const [likers, setLikers] = useState<LikerRow[]>([]);
  const [likersPage, setLikersPage] = useState(1);
  const [likersPages, setLikersPages] = useState(1);
  const [likersMsg, setLikersMsg] = useState('');
  const loadLikers = useCallback(
    async (page: number) => {
      setLikersMsg('加载中...');
      setLikers([]);
      try {
        const limit = 20;
        const res = await fetch(`/api/blogs/${blogId}/likers?offset=${(page - 1) * limit}&limit=${limit}`, {
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.code === 200) {
          const users: LikerRow[] = data.users || data.data?.users || [];
          const total = data.total || data.data?.total || 0;
          setLikers(users);
          setLikersPage(page);
          setLikersPages(Math.max(1, Math.ceil(total / limit)));
          setLikersMsg(users.length ? '' : '暂无点赞者');
        } else {
          setLikersMsg(`加载失败: ${data.message || '未知错误'}`);
        }
      } catch {
        setLikersMsg('网络错误，请稍后重试');
      }
    },
    [blogId]
  );

  // 投喂者列表
  const [feeders, setFeeders] = useState<FeederRow[]>([]);
  const [feedersPage, setFeedersPage] = useState(1);
  const [feedersPages, setFeedersPages] = useState(1);
  const [feedersMsg, setFeedersMsg] = useState('');
  const loadFeeders = useCallback(
    async (page: number) => {
      setFeedersMsg('加载中...');
      setFeeders([]);
      try {
        const limit = 20;
        const res = await fetch(`/api/blogs/${blogId}/feeders?offset=${(page - 1) * limit}&limit=${limit}`, {
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.code === 200) {
          const list: FeederRow[] = data.feeders || [];
          const total = data.total || 0;
          setFeeders(list);
          setFeedersPage(page);
          setFeedersPages(Math.max(1, Math.ceil(total / limit)));
          setFeedersMsg(list.length ? '' : '暂无投喂者');
        } else {
          setFeedersMsg(`加载失败: ${data.message || '未知错误'}`);
        }
      } catch {
        setFeedersMsg('网络错误，请稍后重试');
      }
    },
    [blogId]
  );

  function openLikers() {
    setModal('likers');
    void loadLikers(1);
  }
  function openFeeders() {
    setModal('feeders');
    void loadFeeders(1);
  }

  // 删除
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  async function confirmDelete() {
    if (isAdminDelete && !deleteReason.trim()) {
      toast('请填写删除原因', 'warning');
      return;
    }
    setDeleteBusy(true);
    try {
      const url = isAdminDelete ? `/api/admin/blogs/${blogId}` : `/api/blogs/${blogId}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: isAdminDelete ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'same-origin',
        body: isAdminDelete ? JSON.stringify({ reason: deleteReason.trim() }) : undefined,
      });
      const data = await res.json().catch(() => ({ code: res.status, message: '删除失败' }));
      if (data.code === 200) {
        toast('文章已删除', 'success');
        window.location.href = '/blog';
      } else {
        toast(data.message || '删除失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      {/* 点赞系统 + 投喂触发 + 返回（对齐 like_system 的 .read-controls）*/}
      <div className="read-controls" id="read-controls">
        <button
          id="like-btn"
          className={`like-btn${liked ? ' liked' : ''}`}
          onClick={handleLike}
          disabled={likeBusy}
          aria-label="点赞"
        >
          <span aria-hidden="true">{liked ? '❤' : '♡'}</span>
          <span>{liked ? '已点赞' : '点赞'}</span>
          <span className="like-count-badge" id="like-count">
            {likes}
          </span>
        </button>

        <button
          id="feed-fish-btn"
          className={`fish-btn${fed > 0 ? ' fish-btn--fed' : ''}`}
          onClick={openFeedModal}
          disabled={isAuth && fed >= FEED_CAP}
          aria-label="投喂小鱼干"
        >
          <span aria-hidden="true">🐟</span>
          <span>投喂</span>
          <span className="fish-count-badge" id="fish-count">
            {fishCount}
          </span>
        </button>

        <button onClick={() => history.back()} className="read-btn">
          ← 返回上页
        </button>
      </div>

      {/* 小鱼干投喂弹窗（feed_fish_system）*/}
      <div className={`feed-modal${feedOpen ? ' feed-modal--open' : ''}`} id="feedModal">
        <div className="feed-modal__backdrop" onClick={() => setFeedOpen(false)} />
        <div className="feed-modal__content">
          <div className="feed-modal__header">
            <h3>🐟 投喂小鱼干</h3>
            <p id="feedModalStatus">{feedStatus}</p>
          </div>
          <div className="feed-modal__buttons" id="feedButtons">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`feed-modal__amount-btn${selected === n ? ' feed-modal__amount-btn--selected' : ''}`}
                data-amount={n}
                onClick={() => selectAmount(n)}
                disabled={feedBusy || n > remaining}
              >
                {n} 条
              </button>
            ))}
          </div>
          <div className="feed-modal__actions">
            <button className="feed-modal__close-btn" id="feedCancelBtn" onClick={() => setFeedOpen(false)}>
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

      {/* 管理员/作者控制（admin_controls）*/}
      {canManage && (
        <div className="admin-controls">
          <button id="admin-likers-btn" className="read-btn" onClick={openLikers}>
            查看点赞者
          </button>
          <button id="admin-feeders-btn" className="read-btn" onClick={openFeeders}>
            🐟 查看投喂者
          </button>
          {canEdit && (
            <a href={`/blog/${blogId}/edit`} className="read-btn">
              编辑文章
            </a>
          )}
          <button
            id="admin-delete-btn"
            className="read-btn"
            onClick={() => setModal('delete')}
          >
            删除文章
          </button>
        </div>
      )}

      {/* 点赞者列表 Modal */}
      {canManage && (
        <div
          className={`modal fade${modal === 'likers' ? ' show' : ''}`}
          id="likersModal"
          role="dialog"
          aria-hidden={modal !== 'likers'}
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">点赞者列表</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setModal(null)} />
              </div>
              <div className="modal-body">
                <div id="likers-list" className="list-group" style={{ maxHeight: '50vh', overflow: 'auto' }}>
                  {likersMsg ? (
                    <div className="text-muted">{likersMsg}</div>
                  ) : (
                    likers.map((u) => (
                      <div className="list-group-item" key={u.id}>
                        <div className="d-flex align-items-center">
                          <img
                            src={u.avatar_url || `/api/avatar/${u.id}`}
                            alt={u.username}
                            style={{ width: 32, height: 32, borderRadius: 4, marginRight: 10 }}
                          />
                          <strong>{u.username || '匿名用户'}</strong>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="d-flex justify-content-between align-items-center mt-3">
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    disabled={likersPage <= 1}
                    onClick={() => loadLikers(likersPage - 1)}
                  >
                    上一页
                  </button>
                  <small className="text-muted">
                    第 {likersPage} 页，共 {likersPages} 页
                  </small>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    disabled={likersPage >= likersPages}
                    onClick={() => loadLikers(likersPage + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 投喂者列表 Modal */}
      {canManage && (
        <div
          className={`modal fade${modal === 'feeders' ? ' show' : ''}`}
          id="feedersModal"
          role="dialog"
          aria-hidden={modal !== 'feeders'}
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">🐟 投喂者列表</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setModal(null)} />
              </div>
              <div className="modal-body">
                <div id="feeders-list" className="list-group" style={{ maxHeight: '50vh', overflow: 'auto' }}>
                  {feedersMsg ? (
                    <div className="text-muted">{feedersMsg}</div>
                  ) : (
                    feeders.map((f) => (
                      <div className="list-group-item" key={f.user_id}>
                        <div className="d-flex align-items-center justify-content-between">
                          <div className="d-flex align-items-center">
                            <img
                              src={f.avatar_path ? `/api/avatar/${f.user_id}` : `/api/avatar/${f.user_id}`}
                              alt={f.username}
                              style={{ width: 32, height: 32, borderRadius: 4, marginRight: 10 }}
                            />
                            <strong>{f.username || '未知用户'}</strong>
                          </div>
                          <span
                            className="badge"
                            style={{
                              background: 'var(--color-brand-secondary)',
                              color: 'var(--color-brand-primary)',
                              fontSize: '0.9rem',
                            }}
                          >
                            🐟 {f.amount}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="d-flex justify-content-between align-items-center mt-3">
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    disabled={feedersPage <= 1}
                    onClick={() => loadFeeders(feedersPage - 1)}
                  >
                    上一页
                  </button>
                  <small className="text-muted">
                    第 {feedersPage} 页，共 {feedersPages} 页
                  </small>
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    disabled={feedersPage >= feedersPages}
                    onClick={() => loadFeeders(feedersPage + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 Modal */}
      {canManage && (
        <div
          className={`modal fade${modal === 'delete' ? ' show' : ''}`}
          id="deleteConfirmModal"
          role="dialog"
          aria-hidden={modal !== 'delete'}
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">确认删除</h5>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setModal(null)} />
              </div>
              <div className="modal-body">
                确定要删除这篇文章《{blogTitle}》吗？该操作不可恢复。
                {isAdminDelete && (
                  <div className="mt-3">
                    <label htmlFor="delete-reason" className="form-label">
                      删除原因（管理员必填，将通知作者）：
                    </label>
                    <textarea
                      id="delete-reason"
                      className="form-control"
                      rows={3}
                      maxLength={500}
                      placeholder="请填写删除原因…"
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                    />
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="button button-primary" onClick={() => setModal(null)}>
                  取消
                </button>
                <button
                  type="button"
                  id="confirm-delete-btn"
                  className="button button-warning"
                  onClick={confirmDelete}
                  disabled={deleteBusy}
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}