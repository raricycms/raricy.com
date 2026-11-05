'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UploadProgress.tsx — 上传进度条（纯展示）
//
// 状态只有一个来源：phase（idle / uploading / done）；宽度与文案在这里按阶段映射，
// 旧形状的 width / text 是同一条状态拆出来的两份拷贝，调用方不该分别传。
//
// 结构 / 类名 / id 仍是 DOM 契约（.image-hosting-progress#<id> > __bar >
// __fill#<fillId> + span.numeric#<textId>），显示与否走 style.display，节点始终在 DOM 里。
// ─────────────────────────────────────────────────────────────────────────────

import type { UploadPhase } from '@/app/components/useMediaUpload';

export interface UploadProgressProps {
  /** 外框 id，例如 upload-progress / audio-upload-progress。 */
  id: string;
  /** 填充条 id，例如 progress-fill / audio-progress-fill。 */
  fillId: string;
  /** 文案节点 id，例如 progress-text / audio-progress-text。 */
  textId: string;
  phase: UploadPhase;
}

export default function UploadProgress({ id, fillId, textId, phase }: UploadProgressProps) {
  const done = phase === 'done';
  return (
    <div className="image-hosting-progress" id={id} style={{ display: phase === 'idle' ? 'none' : 'block' }}>
      <div className="image-hosting-progress__bar">
        <div className="image-hosting-progress__fill" id={fillId} style={{ width: done ? '100%' : '0%' }}></div>
      </div>
      <span className="numeric" id={textId}>{done ? '上传成功' : '上传中...'}</span>
    </div>
  );
}
