'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import MediaDropZone from '@/app/components/MediaDropZone';
import UploadProgress from '@/app/components/UploadProgress';
import { showToast } from '@/app/components/toast';
import { useMediaUpload } from '@/app/components/useMediaUpload';

// 与服务端 ALLOWED_AUDIO_MIMETYPES 对应（那里还有 audio/x-m4a 等别名，
// 但 accept 写规范形就够 —— 浏览器按扩展名/类型自己会匹配）
const ACCEPT = 'audio/mpeg,audio/mp4,audio/ogg,.mp3,.m4a,.ogg,.opus';
const MAX_BYTES = 10 * 1024 * 1024;

export default function AudioUploader() {
  const router = useRouter();
  // 音频没有 prepare / extraFields：不做转码，也没有压缩开关。
  const { drag, setDrag, progress, uploadFile } = useMediaUpload({
    endpoint: '/api/audio',
    maxBytes: MAX_BYTES,
    onUploaded: () => router.refresh(),
  });

  return (
    <>
      {/* Upload zone —— 与图床共用 image-hosting-upload* 那套外壳样式，
          差别只在文案与**没有压缩复选框**（音频不做转码，见 audio-upload.ts） */}
      <MediaDropZone
        id="audio-upload-zone"
        fileInputId="audio-file-input"
        accept={ACCEPT}
        drag={drag}
        onDragChange={setDrag}
        onFiles={uploadFile}
        title="拖拽音频到此处，或点击上传"
        hint="支持 MP3 / M4A / OGG，单文件上限 10 MB"
        icon={
          <svg
            className="image-hosting-upload__icon"
            viewBox="0 0 24 24"
            width="48"
            height="48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        }
      />

      {/* Upload progress */}
      <UploadProgress
        id="audio-upload-progress"
        fillId="audio-progress-fill"
        textId="audio-progress-text"
        visible={progress.visible}
        width={progress.width}
        text={progress.text}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioGallery — 音频卡片网格
//   · 每张卡自带播放器（<audio controls>，走 Range 现取）
//   · 复制音频ID / 新窗口打开 / 删除（confirm → DELETE → 移除卡片 + toast）
//
// 与 ImageGallery 的差别：**没有预览模态框**。图片需要放大来看，音频点一下
// 就在卡片里播了，再弹一层只是多一次点击。
// ─────────────────────────────────────────────────────────────────────────────

export interface GalleryAudio {
  id: string;
  filename: string;
  fileSize: number;
}

export function AudioGallery({ items }: { items: GalleryAudio[] }) {
  const router = useRouter();
  const [list, setList] = useState<GalleryAudio[]>(items);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 服务端数据变化时（router.refresh 后）同步本地列表
  useEffect(() => {
    setList(items);
  }, [items]);

  function copyId(audioId: string) {
    navigator.clipboard.writeText(audioId).then(() => {
      setCopiedId(audioId);
      setTimeout(() => setCopiedId((cur) => (cur === audioId ? null : cur)), 1500);
    });
  }

  async function deleteAudio(audioId: string) {
    if (!confirm('确定删除这段音频吗？')) return;
    try {
      const resp = await fetch(`/api/audio/${audioId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const result = await resp.json();
      if (result.code === 200) {
        setList((prev) => prev.filter((i) => i.id !== audioId));
        showToast('已删除', 'success');
        router.refresh();
      } else {
        showToast(result.message || '删除失败', 'error');
      }
    } catch {
      showToast('网络错误', 'error');
    }
  }

  return (
    <div className="image-hosting-grid" id="audio-grid">
      {list.length === 0 ? (
        <div className="image-hosting-grid__empty">
          <svg
            viewBox="0 0 24 24"
            width="48"
            height="48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.3"
          >
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <p>还没有上传音频</p>
          <p>点击上方区域开始上传</p>
        </div>
      ) : (
        list.map((a) => (
          <div key={a.id} className="image-hosting-card" id={`audio-card-${a.id}`}>
            <div className="audio-hosting-card__player">
              {/* 不设 preload="none"：要让用户看见时长。Range 支持让这一次
                  探测只取容器头部那几百字节，不是整份文件。 */}
              <audio controls preload="metadata" src={`/api/audio/${a.id}/raw`} />
            </div>
            <div className="image-hosting-card__info">
              <span className="image-hosting-card__name" title={a.filename}>
                {a.filename}
              </span>
              <span className="image-hosting-card__size numeric">
                {(a.fileSize / 1024 / 1024).toFixed(2)} MB
              </span>
            </div>
            <div className="image-hosting-card__id" title="音频ID">
              {a.id}
            </div>
            <div className="image-hosting-card__actions">
              <button
                className="image-hosting-card__btn"
                onClick={() => copyId(a.id)}
                title="复制音频ID"
              >
                {copiedId === a.id ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              <a
                className="image-hosting-card__btn"
                href={`/api/audio/${a.id}/raw`}
                target="_blank"
                rel="noreferrer"
                title="新窗口打开"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
              <button
                className="image-hosting-card__btn image-hosting-card__btn--danger"
                onClick={() => deleteAudio(a.id)}
                title="删除"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
