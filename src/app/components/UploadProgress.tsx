'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UploadProgress.tsx — 上传进度条（纯展示）
//
// 结构 / 类名 / id 都由 props 决定，与两个上传器里原来那份逐字相同：
//   .image-hosting-progress#<id> > __bar > __fill#<fillId> + span.numeric#<textId>
// 显示与否走 style.display，不用条件渲染 —— 与改动前一致（进度条节点始终在 DOM 里）。
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadProgressProps {
  /** 外框 id，例如 upload-progress / audio-upload-progress。 */
  id: string;
  /** 填充条 id，例如 progress-fill / audio-progress-fill。 */
  fillId: string;
  /** 文案节点 id，例如 progress-text / audio-progress-text。 */
  textId: string;
  visible: boolean;
  width: string;
  text: string;
}

export default function UploadProgress({ id, fillId, textId, visible, width, text }: UploadProgressProps) {
  return (
    <div className="image-hosting-progress" id={id} style={{ display: visible ? 'block' : 'none' }}>
      <div className="image-hosting-progress__bar">
        <div className="image-hosting-progress__fill" id={fillId} style={{ width }}></div>
      </div>
      <span className="numeric" id={textId}>{text}</span>
    </div>
  );
}
