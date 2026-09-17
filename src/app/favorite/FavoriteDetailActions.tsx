'use client';

// 收藏夹详情页的操作区 —— 所有者视图与公开视图共用，用 mode 分支（与 fish/PayForm 的
// variant 分支同一套路：两条路径**共用同一份实现**，只差呈现）。
//
// mode = 'mine'   ：改名 / 删除 / 导出 / 二维码 / 复制成另一种
// mode = 'public' ：只读；唯一动作是「复制为我的收藏夹」
//
// ★ 复制必须说清是**快照** ★ 用户很容易以为是活链接 —— 复制完自己这边删一条，
//   却发现别人的副本没变（或反过来），是那种「用了一阵才隐约觉得不对」的困惑。
//   所以这句提示是正文，不是 title 属性。

import { useRef, useState } from 'react';
import { Lock, Globe, Download, Trash2, Copy, QrCode, Pencil } from 'lucide-react';
import PosterModal from '@/app/components/PosterModal';

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface Props {
  mode: 'mine' | 'public';
  /** 内部 UUID —— 复制/改名/删除都用它（公开视图下也拿得到，但只用于自己的副本）。 */
  id: string;
  isPublic: boolean;
  publicId: string | null;
  title: string;
  /** 复制/删除成功后去哪儿。 */
  redirectTo?: string;
}

export default function FavoriteDetailActions({
  mode,
  id,
  isPublic,
  publicId,
  title,
  redirectTo,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  async function copy(target: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/favorites/${id}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isPublic: target }),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(
          `已复制为${target ? '公开' : '私密'}收藏夹（快照，之后两边各自独立）`,
          'success'
        );
        // 复制出来的那份归我 —— 直接带用户去管理它的页面
        window.location.href = `/favorite/mine/${data.favorite.id}`;
      } else {
        toast(data.message || '复制失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    setBusy(true);
    try {
      const res = await fetch(`/api/favorites/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title: name }),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast('已改名', 'success');
        setRenaming(false);
        window.location.reload();
      } else {
        toast(data.message || '改名失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`确定删除收藏夹「${title}」吗？其中的文章不会被删除。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/favorites/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        toast('已删除', 'success');
        window.location.href = redirectTo ?? '/favorite';
      } else {
        toast(data.message || '删除失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="favorite-actions">
        {/* 复制：两个方向都给。从公开复制成私密（「我把它收起来」）与从私密复制成公开
            （「我决定把它公开」）都是常见诉求，所以不做成「切换」，而是两颗并列的按钮。 */}
        <button type="button" className="read-btn" disabled={busy} onClick={() => void copy(false)}>
          <Lock aria-hidden="true" size={14} /> 复制为私密收藏夹
        </button>
        <button type="button" className="read-btn" disabled={busy} onClick={() => void copy(true)}>
          <Globe aria-hidden="true" size={14} /> 复制为公开收藏夹
        </button>

        {/* 二维码只对公开收藏夹出现 —— 私密收藏夹在库里没有 6 位句柄，生成不出可分享的码 */}
        {isPublic && publicId && (
          <PosterModal
            label={
              <>
                <QrCode aria-hidden="true" size={14} /> 分享二维码
              </>
            }
            src={`/api/poster/favorite/${publicId}`}
            downloadName={`聪明山-收藏夹-${title}.png`}
            title="收藏夹分享二维码"
            hint="扫码即可打开这个收藏夹。二维码指向的是公开链接，任何核心用户都能打开。"
            triggerClassName="read-btn"
          />
        )}

        {mode === 'mine' && (
          <>
            <a className="read-btn" href={`/api/favorites/${id}/export`}>
              <Download aria-hidden="true" size={14} /> 导出 JSON
            </a>
            <button
              type="button"
              className="read-btn"
              disabled={busy}
              onClick={() => {
                setRenaming((v) => !v);
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
            >
              <Pencil aria-hidden="true" size={14} /> 改名
            </button>
            <button type="button" className="read-btn" disabled={busy} onClick={() => void remove()}>
              <Trash2 aria-hidden="true" size={14} /> 删除
            </button>
          </>
        )}

      </div>

      {/* 复制提示放**两种视角都看得到**的位置：两种视角都有「复制」按钮，
          而「以为是活链接」的困惑也两种视角都会发生。 */}
      <p className="favorite-snapshot-note">
        <Copy aria-hidden="true" size={13} style={{ marginRight: 6, verticalAlign: '-2px' }} />
        复制出来的是<strong>快照</strong>：只复制此刻的这些文章，之后两份各走各的 ——
        这边增删条目，那边不会跟着变。
      </p>

      {mode === 'mine' && renaming && (
        <div className="favorite-picker__new" style={{ marginTop: '0.75rem' }}>
          <input
            ref={inputRef}
            className="favorite-picker__input"
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="read-btn" disabled={busy} onClick={() => void rename()}>
            保存
          </button>
        </div>
      )}
    </>
  );
}
