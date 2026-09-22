'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export interface AdminAudioRow {
  id: string;
  filename: string;
  authorName: string | null;
  fileSize: number;
  createdAt: string; // 已在服务端按 UTC+8 墙上时间格式化为 'YYYY-MM-DD HH:MM:SS'（见 lib/format.ts）
}

// 音频床管理表格 + 站长硬删除交互。
//   · 「永久删除」→ confirm → DELETE /api/audio/admin/:id → 移除行 + toast
//
// 与 ImageAdminTable 唯一的差别在预览列：那边是一张缩略图，这边是播放器，
// 且**必须 preload="none"** —— 一页 30 行，metadata 预载就是 30 次 Range 请求，
// 只为显示一个没人看的时长。
export default function AudioAdminTable({ items }: { items: AdminAudioRow[] }) {
  const router = useRouter();
  const [list, setList] = useState<AdminAudioRow[]>(items);

  async function hardDelete(audioId: string, filename: string) {
    if (!confirm(`确定永久删除 "${filename}" 吗？\n此操作不可撤销，将删除文件及记录。`)) return;
    try {
      const resp = await fetch(`/api/audio/admin/${audioId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const result = await resp.json();
      if (result.code === 200) {
        setList((prev) => prev.filter((i) => i.id !== audioId));
        showToast('已永久删除', 'success');
        router.refresh();
      } else {
        showToast(result.message || '删除失败', 'error');
      }
    } catch {
      showToast('网络错误', 'error');
    }
  }

  return (
    <div className="image-hosting-admin-table-wrap">
      <table className="image-hosting-admin-table">
        <thead>
          <tr>
            <th>试听</th>
            <th>文件名</th>
            <th>上传者</th>
            <th>大小</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} id={`row-${a.id}`}>
              <td>
                <audio
                  controls
                  preload="none"
                  src={`/api/audio/${a.id}/raw`}
                  className="audio-admin-row__player"
                />
              </td>
              <td>
                <a
                  href={`/api/audio/${a.id}/raw`}
                  target="_blank"
                  rel="noreferrer"
                  className="image-hosting-admin-filename"
                  title={a.filename}
                >
                  {a.filename}
                </a>
              </td>
              <td>{a.authorName}</td>
              <td>{(a.fileSize / 1024 / 1024).toFixed(2)} MB</td>
              <td>{a.createdAt}</td>
              <td>
                <button
                  className="image-hosting-card__btn image-hosting-card__btn--danger"
                  onClick={() => hardDelete(a.id, a.filename)}
                >
                  永久删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
