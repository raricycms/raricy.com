'use client';

// 我的收藏夹：创建 / 导入 / 列表与每行操作。
//
// 创建与导入都提供**两颗分开的按钮**（私密 / 公开），而不是一个「新建」加一个下拉：
// 性质一经创建不可修改，所以差异必须在**建之前**就摆到用户眼前 —— 藏进下拉框里，
// 用户会在建完之后才发现自己选错，而那时唯一的补救是「复制成另一种」。

import { useRef, useState } from 'react';
import { Lock, Globe, Download, Trash2, Upload } from 'lucide-react';

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface Row {
  id: string;
  publicId: string | null;
  title: string;
  isPublic: boolean;
  itemCount: number;
}

export default function FavoriteMenu({ favorites }: { favorites: Row[] }) {
  const [rows, setRows] = useState(favorites);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ name: string; data: unknown } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function create(isPublic: boolean) {
    const name = title.trim();
    if (!name) {
      toast('请先填写收藏夹名称', 'info');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title: name, isPublic }),
      });
      const data = await res.json();
      if (data.code === 200) {
        setRows((prev) => [
          {
            id: data.favorite.id,
            publicId: data.favorite.public_id,
            title: data.favorite.title,
            isPublic: data.favorite.is_public,
            itemCount: 0,
          },
          ...prev,
        ]);
        setTitle('');
        toast(isPublic ? '已创建公开收藏夹' : '已创建私密收藏夹', 'success');
      } else {
        toast(data.message || '创建失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 选文件：只读进内存，等用户按下「导入为私密/公开」才发请求。 */
  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      setPendingFile({ name: file.name, data: JSON.parse(text) });
      toast(`已选择 ${file.name}，请选择导入成哪种收藏夹`, 'info');
    } catch {
      setPendingFile(null);
      toast('这个文件不是合法的 JSON', 'error');
    }
  }

  async function doImport(isPublic: boolean) {
    if (!pendingFile) {
      toast('请先选择一个 JSON 文件', 'info');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/favorites/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // 文件里的 id / publicId / isPublic 会被服务端忽略，性质以这里的 isPublic 为准
        body: JSON.stringify({ isPublic, data: pendingFile.data }),
      });
      const data = await res.json();
      if (data.code === 200) {
        setRows((prev) => [
          {
            id: data.favorite.id,
            publicId: data.favorite.public_id,
            title: data.favorite.title,
            isPublic: data.favorite.is_public,
            itemCount: data.created,
          },
          ...prev,
        ]);
        toast(`导入成功：新增 ${data.created} 篇，跳过 ${data.skipped} 篇`, 'success');
        setPendingFile(null);
        if (fileRef.current) fileRef.current.value = '';
      } else {
        toast(data.message || '导入失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Row) {
    if (!window.confirm(`确定删除收藏夹「${row.title}」吗？其中的文章不会被删除。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/favorites/${row.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        toast('已删除', 'success');
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
      <div className="favorite-picker__new" style={{ marginBottom: '1.5rem' }}>
        <input
          className="favorite-picker__input"
          type="text"
          value={title}
          maxLength={60}
          placeholder="新收藏夹名称"
          onChange={(e) => setTitle(e.target.value)}
        />
        {/* 名称独占一行，两颗按钮并排在下一行 —— 理由见 _favorite.scss 的
            .favorite-picker__new-actions（两者挤一行时第三颗会被挤到第二行） */}
        <div className="favorite-picker__new-actions">
          <button type="button" className="read-btn" disabled={busy} onClick={() => void create(false)}>
            <Lock aria-hidden="true" size={14} /> 创建私密收藏夹
          </button>
          <button type="button" className="read-btn" disabled={busy} onClick={() => void create(true)}>
            <Globe aria-hidden="true" size={14} /> 创建公开收藏夹
          </button>
        </div>
      </div>

      <div className="favorite-picker__new" style={{ marginBottom: '1.5rem' }}>
        <input
          ref={fileRef}
          className="favorite-picker__input"
          type="file"
          accept="application/json,.json"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
        <div className="favorite-picker__new-actions">
          <button
            type="button"
            className="read-btn"
            disabled={busy || !pendingFile}
            onClick={() => void doImport(false)}
          >
            <Upload aria-hidden="true" size={14} /> 导入为私密收藏夹
          </button>
          <button
            type="button"
            className="read-btn"
            disabled={busy || !pendingFile}
            onClick={() => void doImport(true)}
          >
            <Upload aria-hidden="true" size={14} /> 导入为公开收藏夹
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="favorite-list__empty">
          还没有收藏夹。建一个，然后在看文章时点文章底部那颗星标把文章收进来。
        </div>
      ) : (
        <div className="favorite-list">
          {rows.map((row) => (
            <div className="favorite-item" key={row.id}>
              <div className="favorite-item__main">
                <a className="favorite-item__title" href={`/favorite/mine/${row.id}`}>
                  {row.title}
                </a>
                <div className="favorite-item__meta">
                  <span className={`favorite-badge favorite-badge--${row.isPublic ? 'public' : 'private'}`}>
                    {row.isPublic ? '公开' : '私密'}
                  </span>
                  <span>{row.itemCount} 篇</span>
                  {/* 只有公开收藏夹有 6 位句柄；私密的那格**什么都不渲染**。
                      写的是 JSX 文本 + 表达式，别把模板字符串的 `${}` 搬进来 ——
                      写成 `[@${row.publicId}]` 会原样渲染出「[@$123456]」，
                      而那个句柄是要拿去粘进 `[@六位ID]` 引用的。 */}
                  {row.isPublic && row.publicId && (
                    <span className="favorite-handle">[@{row.publicId}]</span>
                  )}
                </div>
              </div>
              <div className="favorite-actions">
                {/* 服务端已带 Content-Disposition: attachment，普通链接即可下载 */}
                <a className="read-btn" href={`/api/favorites/${row.id}/export`}>
                  <Download aria-hidden="true" size={14} /> 导出 JSON
                </a>
                <button
                  type="button"
                  className="read-btn"
                  disabled={busy}
                  onClick={() => void remove(row)}
                >
                  <Trash2 aria-hidden="true" size={14} /> 删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
