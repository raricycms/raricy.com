'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MediaDropZone.tsx — 上传器的拖拽区外壳（纯展示 + 事件）
//
// DOM 契约不变：外层仍是 `image-hosting-upload[--drag]`，隐藏 file input 放在区内，
// 点整块区域等于点 input。**两个 id 都要显式传**：外层的 zone id 与 input id 在不同
// 页面命名不同（upload-zone / file-input、audio-upload-zone / audio-file-input），
// 由调用方给，别在这里拼字符串。
//
// 差异内容（图标、主文案、提示、以及图床专属的压缩复选框）都从 props 进来；
// 压缩复选框通过 children 插在提示与 input 之间，与改动前的兄弟顺序一致。
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, type ReactNode } from 'react';

export interface MediaDropZoneProps {
  /** 拖拽区外层 id（DOM 契约，e2e / 样式可能依赖）。 */
  id: string;
  /** 隐藏 file input 的 id（DOM 契约）。 */
  fileInputId: string;
  accept: string;
  drag: boolean;
  icon: ReactNode;
  title: string;
  hint: string;
  children?: ReactNode;
  onDragChange: (drag: boolean) => void;
  onFiles: (file: File) => void;
}

export default function MediaDropZone({
  id,
  fileInputId,
  accept,
  drag,
  icon,
  title,
  hint,
  children,
  onDragChange,
  onFiles,
}: MediaDropZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`image-hosting-upload${drag ? ' image-hosting-upload--drag' : ''}`}
      id={id}
      onClick={() => fileInputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        onDragChange(true);
      }}
      onDragLeave={() => onDragChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragChange(false);
        const files = e.dataTransfer.files;
        if (files.length > 0) onFiles(files[0]);
      }}
    >
      {icon}
      <p className="image-hosting-upload__text">{title}</p>
      <p className="image-hosting-upload__hint">{hint}</p>
      {children}
      <input
        type="file"
        id={fileInputId}
        accept={accept}
        hidden
        ref={fileInputRef}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onFiles(e.target.files[0]);
        }}
      />
    </div>
  );
}
