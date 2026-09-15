'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ImagePickerModal.tsx — 「从图床选择」：挑一张**已上传**的图当待发附件
//
// 【为什么需要】此前讨论与评论发图只有「现传现发」一条路。要引用一张早就传过的图
// （比如反复用的表情 / 示意图），得先在本地找到那个文件再传一遍 —— 图床上明明
// 已经有一份。本组件就是那条捷径。
//
// 【数据源】GET /api/images（core+，只列**自己**未软删的图，最新在前）。它没有
// 分页也没有搜索参数，所以过滤在客户端做。
//
// 【为什么客户端截断】该接口一次给全量：一个用户攒了 500 张图就是 500 个
// <img src="/api/images/*/raw"> 同时开请求。首屏只渲染前 REVEAL_STEP 张，
// 「显示更多」再放一批（配合 loading="lazy"，实际请求量由视口决定）。
//
// 【弹窗外壳】照抄 QuoteBlogModal 的 `modal-overlay show` / `modal-dialog` /
// `modal-content` —— ⚠️ 展开类是 `show`，**不是** Bootstrap 那套，也不是站内另一套
// modal 系统的 `is-open`。写错的表现是弹窗恒为 display:none（用户那边就是「点了
// 没反应」），而接口与单测全都正常。comment-rich.spec.ts 里有一条注释记着这个坑。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, Images } from 'lucide-react';
import type { PendingImage } from './usePendingImage';

interface LibraryImage {
  id: string;
  filename: string;
  url: string;
}

/** 首屏渲染多少张；「显示更多」每次再加这么多。 */
const REVEAL_STEP = 24;

export default function ImagePickerModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  /** 选中一张图 → 交给调用方设为待发附件。 */
  onPick: (image: PendingImage) => void;
}) {
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState(REVEAL_STEP);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/images', { credentials: 'same-origin' });
        const data = (await res.json()) as { code?: number; images?: unknown };
        if (cancelled) return;
        if (data.code === 200 && Array.isArray(data.images)) {
          setImages(
            (data.images as { id?: unknown; filename?: unknown; url?: unknown }[])
              .filter((i): i is LibraryImage => typeof i.id === 'string')
              .map((i) => ({
                id: i.id,
                filename: typeof i.filename === 'string' ? i.filename : i.id,
                url: typeof i.url === 'string' ? i.url : `/api/images/${i.id}/raw`,
              }))
          );
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return images;
    return images.filter(
      (i) => i.filename.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)
    );
  }, [images, query]);

  const shown = filtered.slice(0, reveal);

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal-dialog image-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">从图床选择</h3>
            <button type="button" className="chat-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="modal-body">
            <input
              ref={inputRef}
              type="search"
              className="form-control chat-new-search"
              placeholder="搜索文件名 / 图片 ID…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setReveal(REVEAL_STEP); // 换了过滤条件就收回首屏
              }}
            />

            <div className="image-picker-scroll">
              {loading ? (
                <div className="chat-new-empty">加载中…</div>
              ) : failed ? (
                <div className="chat-new-empty">图床列表加载失败，请稍后重试</div>
              ) : filtered.length === 0 ? (
                <div className="image-picker-empty">
                  <ImageOff aria-hidden="true" />
                  <p>{images.length === 0 ? '你还没有上传过图片' : '没有匹配的图片'}</p>
                  {images.length === 0 && (
                    <a className="image-picker-empty__link" href="/image">
                      去图床上传
                    </a>
                  )}
                </div>
              ) : (
                <>
                  <div className="image-picker-grid">
                    {shown.map((img) => (
                      <button
                        key={img.id}
                        type="button"
                        className="image-picker-card"
                        title={img.filename}
                        onClick={() => onPick({ id: img.id, url: img.url })}
                      >
                        {/* 缩略图直接打原图接口：本站图床没有生成缩略图，而列表已按
                            首屏截断，实际并发由 loading="lazy" 与视口决定 */}
                        <img src={img.url} alt={img.filename} loading="lazy" />
                      </button>
                    ))}
                  </div>
                  {filtered.length > shown.length && (
                    <button
                      type="button"
                      className="image-picker-more"
                      onClick={() => setReveal((n) => n + REVEAL_STEP)}
                    >
                      显示更多（还有 {filtered.length - shown.length} 张）
                    </button>
                  )}
                </>
              )}
            </div>

            <p className="image-picker-hint">
              <Images aria-hidden="true" />
              只能选你自己上传的图片；选中的图会作为附件发送。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
