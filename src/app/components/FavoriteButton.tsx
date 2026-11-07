'use client';

// FavoriteButton — 文章详情页「收藏」按钮 + 收藏夹选择器。
//
// 由 BlogReactions 挂在 .read-controls 的第一行（与 点赞 / 投喂 并列）。刻意单独一个
// 组件而不是塞进点赞/投喂那一块：读者写路径只负责「收藏」这一条事实，管理/删除弹窗
// 已拆到 BlogManageDialogs，壳层 FeedButton 只做布局与 overlay 编排。
//
// 与点赞/投喂的三处**刻意不同**：
//   • **没有计数徽标** —— 站内不显示一篇文章的被收藏数（收藏夹可以复制，那个数字既
//     无意义，又会让作者误以为「有人收藏了我的文章」）。所以这里只有 收藏 / 已收藏。
//   • **一篇可以进多个收藏夹** —— 所以选择器是多选（复选框），不是点赞那种开关。
//   • **不推通知** —— 作者不会收到任何提示，这是需求明确要求的。
//
// 按钮由 `BlogReactions` 渲染，而它只出现在 `member` 分支（`isCore && user`）——
// 所以这里不再自带「未登录 → 跳登录 / 非 core → 提示」两道分支（恒真，见 Props 处说明）。
// 「入口不跟着藏」那条红线由壳层负责：访客看到的是「收藏」不可用，而不是按钮消失。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Globe, Star } from 'lucide-react';
import { showToast } from './toast';
import { FAVORITE_TITLE_MAX } from '@/lib/favorite-refs';

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
  /** 当前用户的任一收藏夹是否含本文（服务端查好传来，避免首帧抖动）。 */
  initialFavorited: boolean;
}

// 按钮只渲染在 `member` 分支里（blog/[id]/page.tsx：`member = isCore && user`），
// 所以「未登录 / 非 core」两条分支在这里永远走不到 —— 不再传 isAuth / isCore 两个
// 恒真 props。访客可见属于产品变更，真要做时连同调用点一起改，别只在这加回分支。
export default function FavoriteButton({ blogId, initialFavorited }: Props) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FavoriteRow[]>([]);
  const [loading, setLoading] = useState(false);
  /** 加载失败的原因；null = 没失败。与「还没有收藏夹」必须可区分（见渲染处）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  /** 选择器关闭后把焦点还给星标；打开时把焦点送进弹窗 —— 见下面的 effect。 */
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 选择器是站内 dialog，必须与兄弟弹窗（FeedButton / DailyQuoteModal）同一套键盘契约：
  // Esc 关闭、打开时焦点进弹窗、关闭时归还给触发按钮。`.modal` 关闭态是 display:none，
  // 不加这段时 Tab 会继续在背景内容里走，读屏也读不出「这是个弹窗」。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // 焦点送进关闭按钮（第一个可聚焦元素）：既宣布了弹窗，也不会让 Tab 越界第一步就跑到背景。
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      triggerRef.current?.focus();
    };
  }, [open]);

  /** 拉我的收藏夹 + 本文的归属（一次请求拿全）。 */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/favorites?blogId=${encodeURIComponent(blogId)}`, {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setRows(data.favorites as FavoriteRow[]);
        setFavorited((data.favorites as FavoriteRow[]).some((f) => f.contains));
      } else {
        // 失败不能落进「还没有收藏夹」的空态 —— 那会把 401/403/500 说成「你一个都没建」，
        // 用户照着提示去新建，反而可能建出重复的同名夹。
        const message = data.message || '加载收藏夹失败';
        setLoadError(message);
        showToast(message, 'error');
      }
    } catch {
      setLoadError('网络错误，请稍后重试');
      showToast('网络错误，请稍后重试', 'error');
    } finally {
      setLoading(false);
    }
  }, [blogId]);

  function openPicker() {
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
        showToast(next ? '已收藏' : '已取消收藏', 'success');
      } else {
        showToast(data.message || '操作失败', 'error');
      }
    } catch {
      showToast('网络错误，请稍后重试', 'error');
    } finally {
      setBusyId(null);
    }
  }

  /** 新建收藏夹（并顺手把本文放进去）。isPublic 由**两颗不同的按钮**决定。 */
  async function create(isPublic: boolean) {
    const title = newTitle.trim();
    if (!title) {
      showToast('请先填写收藏夹名称', 'info');
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
        showToast(data.message || '创建失败', 'error');
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
        showToast(isPublic ? '已创建站内共享收藏夹并收藏' : '已创建私密收藏夹并收藏', 'success');
        await load();
      } else {
        showToast(addData.message || '收藏失败', 'error');
      }
    } catch {
      showToast('网络错误，请稍后重试', 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id="favorite-btn"
        type="button"
        className={`favorite-btn${favorited ? ' favorited' : ''}`}
        onClick={openPicker}
        aria-label={favorited ? '已收藏' : '收藏'}
        aria-pressed={favorited}
        title={favorited ? '已收藏' : '收藏'}
      >
        <span className="icon icon-star-fill" aria-hidden="true"></span>
      </button>

      <div
        className={`modal${open ? ' is-open' : ''}`}
        id="favoritePickerModal"
        role="dialog"
        aria-modal={open}
        aria-labelledby="favorite-picker-title"
        aria-hidden={!open}
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title" id="favorite-picker-title">
                <Star aria-hidden="true" style={{ marginRight: '0.5rem' }} />
                收藏到收藏夹
              </h5>
              <button
                ref={closeRef}
                type="button"
                className="btn-close"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              />
            </div>
            <div className="modal-body">
              {loading ? (
                <div className="favorite-picker__empty">加载中…</div>
              ) : loadError ? (
                <div className="favorite-picker__empty">
                  {loadError}{' '}
                  <button type="button" className="read-btn" onClick={() => void load()}>
                    重试
                  </button>
                </div>
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
                      <span className="favorite-picker__count numeric">{row.item_count} 篇</span>
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
                  maxLength={FAVORITE_TITLE_MAX}
                  placeholder="新收藏夹名称"
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <div className="favorite-picker__new-actions">
                  <button
                    type="button"
                    className="read-btn"
                    disabled={creating}
                    onClick={() => void create(false)}
                    aria-label="创建私密收藏夹"
                    title="只有你能看到；不显示 ID，无法分享、无法被机器人读取，但可以导出 JSON"
                  >
                    <Lock aria-hidden="true" size={14} /> 创建私密
                  </button>
                  <button
                    type="button"
                    className="read-btn"
                    disabled={creating}
                    onClick={() => void create(true)}
                    aria-label="创建站内共享收藏夹"
                    title="成员凭分享链接可读，也可用 [@ID] 引用"
                  >
                    <Globe aria-hidden="true" size={14} /> 创建站内共享
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
