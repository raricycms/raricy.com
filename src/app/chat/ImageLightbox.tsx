'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ImageLightbox.tsx — 聊天图片原位放大（覆盖层）
//
// 点消息里的图片不再新开窗口：在当前页盖一层黑底把图放大，点任意处 / Esc 关闭。
// 观感对齐博客正文与云剪贴板的图片放大（MarkdownRenderer / ClipDetailClient 的
// 内联覆盖层）；那两处是给 innerHTML 挂 onclick，只能手搓 DOM 节点 —— 聊天消息
// 本来就是 React 渲染的，用状态开关更省事：Esc 监听与卸载清理都归组件管。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';

export default function ImageLightbox({
  src,
  alt = '图片',
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      {/* 点图片本身不关闭（只有点黑底才关），否则想细看时会误关 */}
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="chat-lightbox__close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
