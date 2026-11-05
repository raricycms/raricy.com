'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, prepareImageFile } from '@/lib/image-client';
import MediaDropZone from '@/app/components/MediaDropZone';
import UploadProgress from '@/app/components/UploadProgress';
import { showToast } from '@/app/components/toast';
import { useMediaUpload, type PreparedFile } from '@/app/components/useMediaUpload';

const ACCEPT = `${IMAGE_ACCEPT},image/svg+xml`;
const MAX_BYTES = MAX_IMAGE_BYTES;

export default function ImageUploader() {
  const router = useRouter();
  const compressRef = useRef<HTMLInputElement>(null);
  const { drag, setDrag, progress, uploadFile } = useMediaUpload({
    endpoint: '/api/images',
    maxBytes: MAX_BYTES,
    // 图床页是**唯一**允许 SVG 的上传入口（raw 路由对 SVG 强制附件下载，安全）；
    // HEIC 在这里被就地转成 JPEG —— 服务端没有 HEVC 解码器。
    //
    // prepareImageFile 自己会把「读不到 / 转不了」resolve 成 { ok:false }，这里再包一层
    // 是因为它内部还调了浏览器 API（FileReader / File 构造）——真抛出来时若没人接，
    // 表现就是「点了上传，界面毫无反应」。catch 后归到同一种 ok:false，由 hook 统一提示。
    prepare: async (file): Promise<PreparedFile> => {
      let prepared: Awaited<ReturnType<typeof prepareImageFile>>;
      try {
        prepared = await prepareImageFile(file, { allowSvg: true });
      } catch {
        return { ok: false, message: '图片读取失败，请重试' };
      }
      if (!prepared.ok) return prepared;
      // 转换后未必更小（HEIC → JPEG 在极端情况下反而变大），仍要卡 10 MB 上限。
      // 这一步只有图床有 —— 音频不做转码，所以校验留在 prepare 里。
      if (prepared.file.size > MAX_BYTES) {
        return { ok: false, message: '图片转换后仍超过 10 MB，请先压缩或缩小尺寸' };
      }
      return prepared;
    },
    // 复选框非受控：值必须在提交那一刻读（见 useMediaUpload 的 extraFields 说明）。
    extraFields: () => ({ compress: compressRef.current?.checked ? '1' : '0' }),
    // 成功动画（100% 停 500ms）走完再刷新，与改动前一致。
    onUploaded: () => router.refresh(),
  });

  return (
    <>
      {/* Upload zone */}
      <MediaDropZone
        id="upload-zone"
        fileInputId="file-input"
        accept={ACCEPT}
        drag={drag}
        onDragChange={setDrag}
        onFiles={uploadFile}
        title="拖拽图片到此处，或点击上传"
        hint="支持 PNG / JPEG / GIF / WebP / SVG，单文件上限 10 MB；iPhone 的 HEIC 会自动转成 JPEG"
        icon={
          <svg className="image-hosting-upload__icon" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        }
      >
        {/* 图床专属：压缩开关（音频不做转码，没有这一项） */}
        <label className="image-hosting-upload__compress" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" id="compress-toggle" ref={compressRef} defaultChecked /> 压缩图片（减小文件体积，轻微损失画质）
        </label>
      </MediaDropZone>

      {/* Upload progress */}
      <UploadProgress
        id="upload-progress"
        fillId="progress-fill"
        textId="progress-text"
        visible={progress.visible}
        width={progress.width}
        text={progress.text}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ImageGallery — 图片网格 + 预览模态框
//   · 卡片点击 → 打开预览模态框
//   · 复制图片ID（复制后按钮图标切为对勾，1.5s 复原）
//   · 新窗口打开 / 删除（confirm → DELETE → 移除卡片 + toast）
//   · 模态框：点击遮罩关闭、Esc 关闭、复制图片ID（文案切「已复制」1.5s）
// ─────────────────────────────────────────────────────────────────────────────

export interface GalleryImage {
  id: string;
  filename: string;
  fileSize: number;
}

interface PreviewState {
  url: string;
  name: string;
  id: string;
}

export function ImageGallery({ images, isOwner = false }: { images: GalleryImage[]; isOwner?: boolean }) {
  const router = useRouter();
  const [list, setList] = useState<GalleryImage[]>(images);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewCopied, setPreviewCopied] = useState(false);

  // 服务端数据变化时（router.refresh 后）同步本地列表
  useEffect(() => {
    setList(images);
  }, [images]);

  // Esc 关闭预览
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreview(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function copyLink(imageId: string) {
    navigator.clipboard.writeText(imageId).then(() => {
      setCopiedId(imageId);
      setTimeout(() => setCopiedId((cur) => (cur === imageId ? null : cur)), 1500);
    });
  }

  function copyPreviewLink() {
    if (!preview) return;
    navigator.clipboard.writeText(preview.id).then(() => {
      setPreviewCopied(true);
      setTimeout(() => setPreviewCopied(false), 1500);
    });
  }

  function showPreview(img: GalleryImage) {
    setPreview({ url: `/api/images/${img.id}/raw`, name: img.filename, id: img.id });
    setPreviewCopied(false);
  }

  async function deleteImage(imageId: string) {
    if (!confirm('确定删除这张图片吗？')) return;
    try {
      const resp = await fetch(`/api/images/${imageId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const result = await resp.json();
      if (result.code === 200) {
        setList((prev) => prev.filter((i) => i.id !== imageId));
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
    <>
      <div className="image-hosting-grid" id="image-grid">
        {list.length === 0 ? (
          <div className="image-hosting-grid__empty">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
            <p>还没有上传图片</p>
            <p>点击上方区域开始上传</p>
          </div>
        ) : (
          list.map((img) => (
            <div key={img.id} className="image-hosting-card" id={`card-${img.id}`}>
              <div className="image-hosting-card__preview" onClick={() => showPreview(img)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/images/${img.id}/raw`} alt={img.filename} loading="lazy" />
              </div>
              <div className="image-hosting-card__info">
                <span className="image-hosting-card__name" title={img.filename}>{img.filename}</span>
                <span className="image-hosting-card__size numeric">{(img.fileSize / 1024).toFixed(1)} KB</span>
              </div>
              <div className="image-hosting-card__id" title="图片ID">{img.id}</div>
              <div className="image-hosting-card__actions">
                <button className="image-hosting-card__btn" onClick={() => copyLink(img.id)} title="复制图片ID">
                  {copiedId === img.id ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  )}
                </button>
                <a className="image-hosting-card__btn" href={`/api/images/${img.id}/raw`} target="_blank" rel="noreferrer" title="新窗口打开">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                </a>
                <button className="image-hosting-card__btn image-hosting-card__btn--danger" onClick={() => deleteImage(img.id)} title="删除">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Preview modal */}
      <div
        className="image-hosting-preview"
        id="preview-modal"
        style={{ display: preview ? 'flex' : 'none' }}
        onClick={() => setPreview(null)}
      >
        <div className="image-hosting-preview__content" onClick={(e) => e.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img id="preview-img" src={preview?.url ?? ''} alt={preview?.name ?? ''} />
          <div className="image-hosting-preview__info">
            <span id="preview-name">{preview?.name ?? ''}</span>
            <div>
              <button className="image-hosting-card__btn" id="preview-copy-btn" onClick={copyPreviewLink}>
                {previewCopied ? '已复制' : '复制图片ID'}
              </button>
              {/* owner 专属：图片管理（/image/admin 图床专属管理页）。 */}
              {isOwner && (
                <a className="image-hosting-card__btn" href="/image/admin">图片管理</a>
              )}
            </div>
          </div>
          <button className="image-hosting-preview__close" onClick={() => setPreview(null)}>&times;</button>
        </div>
      </div>
    </>
  );
}
