'use client';

// FavoriteButton — 文章详情页「收藏」按钮 + 收藏夹选择器。
//
// 由 FeedButton 挂在 .read-controls 的第一行（与 点赞 / 投喂 并列）。刻意单独一个
// 组件而不是塞进 FeedButton：那边已经背着点赞、投喂、点赞者/投喂者/管理/删除四个
// 弹窗，再加一个只会让它更难读（FeedButton 的类名与行结构被 e2e 钉着，也不宜大改）。
//
// 与点赞/投喂的三处**刻意不同**：
//   • **没有计数徽标** —— 站内不显示一篇文章的被收藏数（收藏夹可以复制，那个数字既
//     无意义，又会让作者误以为「有人收藏了我的文章」）。所以这里只有 收藏 / 已收藏。
//   • **一篇可以进多个收藏夹** —— 所以选择器是多选（复选框），不是点赞那种开关。
//   • **不推通知** —— 作者不会收到任何提示，这是需求明确要求的。
//
// 按钮**对所有人渲染**（未登录 → 跳登录，非 core → 就地提示），不跟着档位藏 ——
// 与点赞/投喂一致，符合 CLAUDE.md 的「入口不跟着藏」。

import { useCallback, useState } from 'react';
import { Lock, Globe, Star } from 'lucide-react';

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface FavoriteRow {
  id: string;
  public_id: string | null;
  title: string;
  is_public: boolean;
  item_count: number;
  contains?: boolean;
}

interface Props {
  blogId: string;
  isAuth: boolean;
  isCore: boolean;
  /** 当前用户的任一收藏夹是否含本文（服务端查好传来，避免首帧抖动）。 */
  initialFavorited: boolean;
}

export default function FavoriteButton({ blogId, isAuth, isCore, initialFavorited }: Props) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FavoriteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  /** 拉我的收藏夹 + 本文的归属（一次请求拿全）。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/favorites?blogId=${encodeURIComponent(blogId)}`, {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setRows(data.favorites as FavoriteRow[]);
        setFavorited((data.favorites as FavoriteRow[]).some((f) => f.contains));
      } else {
        toast(data.message || '加载收藏夹失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setLoading(false);
    }
  }, [blogId]);

  function openPicker() {
    if (!isAuth) {
      toast('请先登录后再收藏', 'info');
      window.location.href = '/login';
      return;
    }
    if (!isCore) {
      toast('需要核心用户权限', 'error');
      return;
    }
    setOpen(true);
    void load();
  }

  /** 勾选 / 取消勾选某个收藏夹。 */
  async function toggle(row: FavoriteRow) {
    setBusyId(row.id);
    const next = !row.contains;
    try {
      const res = next
        ? await fetch(`/api/favorites/${row.id}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ blogId }),
          })
        : await fetch(`/api/favorites/${row.id}/items/${blogId}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
      const data = await res.json();
      if (data.code === 200) {
        setRows((prev) => {
          const after = prev.map((r) =>
            r.id === row.id
              ? { ...r, contains: next, item_count: data.item_count ?? r.item_count }
              : r
          );
          setFavorited(after.some((r) => r.contains));
          return after;
        });
        toast(next ? '已收藏' : '已取消收藏', 'success');
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusyId(null);
    }
  }

  /** 新建收藏夹（并顺手把本文放进去）。isPublic 由**两颗不同的按钮**决定。 */
  async function create(isPublic: boolean) {
    const title = newTitle.trim();
    if (!title) {
      toast('请先填写收藏夹名称', 'info');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title, isPublic }),
      });
      const data = await res.json();
      if (data.code !== 200) {
        toast(data.message || '创建失败', 'error');
        return;
      }
      const created = data.favorite as FavoriteRow;
      // 新夹子是空的 —— 立刻把当前这篇放进去，否则用户点了「创建」却发现没收藏上
      const add = await fetch(`/api/favorites/${created.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ blogId }),
      });
      const addData = await add.json();
      if (addData.code === 200) {
        setNewTitle('');
        setFavorited(true);
        toast(isPublic ? '已创建公开收藏夹并收藏' : '已创建私密收藏夹并收藏', 'success');
        await load();
      } else {
        toast(addData.message || '收藏失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <button
        id="favorite-btn"
        type="button"
        className={`favorite-btn${favorited ? ' favorited' : ''}`}
        onClick={openPicker}
        aria-label={favorited ? '已收藏' : '收藏'}
      >
        <span className="icon icon-star-fill" aria-hidden="true"></span>
        <span>{favorited ? '已收藏' : '收藏'}</span>
      </button>

      <div
        className={`modal${open ? ' is-open' : ''}`}
        id="favoritePickerModal"
        role="dialog"
        aria-hidden={!open}
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">
                <Star aria-hidden="true" style={{ marginRight: '0.5rem' }} />
                收藏到收藏夹
              </h5>
              <button
                type="button"
                className="btn-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              />
            </div>
            <div className="modal-body">
              {loading ? (
                <div className="favorite-picker__empty">加载中…</div>
              ) : rows.length === 0 ? (
                <div className="favorite-picker__empty">
                  还没有收藏夹。在下面建一个吧 —— 同一篇文章可以同时放进多个收藏夹。
                </div>
              ) : (
                <div className="favorite-picker__list">
                  {rows.map((row) => (
                    <label className="favorite-picker__row" key={row.id}>
                      <input
                        type="checkbox"
                        checked={!!row.contains}
                        disabled={busyId === row.id}
                        onChange={() => void toggle(row)}
                      />
                      {row.is_public ? (
                        <Globe aria-hidden="true" size={14} />
                      ) : (
                        <Lock aria-hidden="true" size={14} />
                      )}
                      <span className="favorite-picker__title">{row.title}</span>
                      <span className="favorite-picker__count">{row.item_count} 篇</span>
                    </label>
                  ))}
                </div>
              )}

              {/* 两个入口分开列，是为了让「私密 / 公开」的性质差异在**建之前**就可见 ——
                  性质一经创建不可修改，所以不能在一个含糊的「新建」里让用户事后才发现。
                  名称独占一行、两颗按钮在下一行并排（见 _favorite.scss 的
                  .favorite-picker__new-actions）：三者挤一行时第三颗会被挤下去。 */}
              <div className="favorite-picker__new">
                <input
                  className="favorite-picker__input"
                  type="text"
                  value={newTitle}
                  maxLength={60}
                  placeholder="新收藏夹名称"
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <div className="favorite-picker__new-actions">
                  <button
                    type="button"
                    className="read-btn"
                    disabled={creating}
                    onClick={() => void create(false)}
                    title="只有你能看到；不显示 ID，无法分享、无法被机器人读取，但可以导出 JSON"
                  >
                    <Lock aria-hidden="true" size={14} /> 创建私密收藏夹
                  </button>
                  <button
                    type="button"
                    className="read-btn"
                    disabled={creating}
                    onClick={() => void create(true)}
                    title="任何人可见；有 6 位 ID，可以分享、生成二维码、用 [@ID] 内嵌到文章里"
                  >
                    <Globe aria-hidden="true" size={14} /> 创建公开收藏夹
                  </button>
                </div>
              </div>
            </div>
            {/* 会点开选择器的人，正是想整理收藏夹的人 —— 把管理入口放在这里，
                否则它只存在于顶栏头像菜单里，等于没有入口。 */}
            <div className="modal-footer">
              <a className="favorite-picker__manage" href="/favorite">
                管理收藏夹 →
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
