'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export interface AdminImageRow {
  id: string;
  filename: string;
  authorName: string | null;
  fileSize: number;
  createdAt: string; // 已按 Flask to_dict 的 isoformat 序列化
}

// 图床管理表格 + 站长硬删除交互，逐字对齐 Flask image_hosting/admin.html。
//   · 「永久删除」→ confirm → DELETE /api/images/admin/:id → 移除行 + toast
export default function ImageAdminTable({ images }: { images: AdminImageRow[] }) {
  const router = useRouter();
  const [list, setList] = useState<AdminImageRow[]>(images);

  async function hardDelete(imageId: string, filename: string) {
    if (!confirm(`确定永久删除 "${filename}" 吗？\n此操作不可撤销，将删除文件及记录。`)) return;
    try {
      const resp = await fetch(`/api/images/admin/${imageId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const result = await resp.json();
      if (result.code === 200) {
        setList((prev) => prev.filter((i) => i.id !== imageId));
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
            <th>预览</th>
            <th>文件名</th>
            <th>上传者</th>
            <th>大小</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((img) => (
            <tr key={img.id} id={`row-${img.id}`}>
              <td>
                <a href={`/api/images/${img.id}/raw`} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/images/${img.id}/raw`}
                    alt={img.filename}
                    className="image-hosting-admin-thumb"
                  />
                </a>
              </td>
              <td>
                <a
                  href={`/api/images/${img.id}/raw`}
                  target="_blank"
                  rel="noreferrer"
                  className="image-hosting-admin-filename"
                  title={img.filename}
                >
                  {img.filename}
                </a>
              </td>
              <td>{img.authorName}</td>
              <td>{(img.fileSize / 1024).toFixed(1)} KB</td>
              <td>{img.createdAt}</td>
              <td>
                <button
                  className="image-hosting-card__btn image-hosting-card__btn--danger"
                  onClick={() => hardDelete(img.id, img.filename)}
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
