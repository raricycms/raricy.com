'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useMediaUpload.ts — 图床 / 音频上传器共用的上传主链路
//
// 收拢的是两边**逐字相同**的那段：大小校验 → FormData → 假进度 → fetch →
// `code === 200` → 100% 停 500ms → 隐藏并刷新。
//
// 配置只有三项，每项都是两侧真实会变的：endpoint（唯一不可推导的差异）；maxBytes
// （超限提示的 MB 数由它推导，别处不再写字面量）；buildPayload（可选，图床在此做
// HEIC 转码 / SVG 放行 / 转换后再卡上限 / compress 字段，音频不做转码、整项不传）。
// 成功后的刷新是两侧原本相同的默认行为，不是配置项。
//
// 三条被固化的既有约定：没有真实进度（0% → 100% 只是视觉反馈，停 500ms 再隐藏）；
// 成败只看 `code === 200`（/api/images 的多文件通道只给站外 bot 用，不经过本 hook）；
// 只处理用户选/拖的**第一份**文件。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { showToast } from './toast';

/**
 * buildPayload 的返回：成功给真正要发的 File（可能已被转码/改名）和额外表单字段；
 * 失败给一句能直接进 toast 的话 —— 措辞留给调用方，只有它知道是格式不支持还是超限。
 */
export type UploadPayload =
  | { ok: true; file: File; fields?: Record<string, string> }
  | { ok: false; message: string };

export interface MediaUploadConfig {
  /** POST 目标，例如 '/api/images'。 */
  endpoint: string;
  /** 单文件上限（字节）；超限提示里的 MB 数由它推导。 */
  maxBytes: number;
  /**
   * 可选：提交前把 File 换成真正要发的 File，并附上额外表单字段。图床侧在此做
   * HEIC → JPEG、放行 SVG、转换后再卡上限并带上 compress；音频侧整项不传。
   */
  buildPayload?: (file: File) => Promise<UploadPayload>;
}

/** 进度只有三个阶段；宽度与文案由 UploadProgress 按阶段映射，不各存一份。 */
export type UploadPhase = 'idle' | 'uploading' | 'done';

export interface MediaUploadState {
  drag: boolean;
  setDrag: (drag: boolean) => void;
  phase: UploadPhase;
  uploadFile: (file: File) => Promise<void>;
}

/** maxBytes → 面向用户的 MB 文案；toast 与各调用方的 hint 都从这里取，别写字面量。 */
export function maxBytesLabel(maxBytes: number): string {
  return `${Math.round(maxBytes / (1024 * 1024))} MB`;
}

export function useMediaUpload(config: MediaUploadConfig): MediaUploadState {
  const router = useRouter();
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>('idle');

  async function uploadFile(file: File) {
    if (file.size > config.maxBytes) {
      showToast(`文件过大，单文件上限 ${maxBytesLabel(config.maxBytes)}`, 'error');
      return;
    }

    let payload: UploadPayload = { ok: true, file };
    if (config.buildPayload) {
      payload = await config.buildPayload(file);
      if (!payload.ok) {
        showToast(payload.message, 'error');
        return;
      }
    }

    const formData = new FormData();
    formData.append('file', payload.file);
    for (const [key, value] of Object.entries(payload.fields ?? {})) {
      formData.append(key, value);
    }

    setPhase('uploading');

    try {
      const resp = await fetch(config.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      const result = await resp.json();

      if (result.code === 200) {
        setPhase('done');
        // 成功动画（100% 停 500ms）走完再刷新，与改动前一致。
        setTimeout(() => {
          setPhase('idle');
          router.refresh();
        }, 500);
      } else {
        setPhase('idle');
        showToast(result.message || '上传失败', 'error');
      }
    } catch {
      setPhase('idle');
      showToast('网络错误，请重试', 'error');
    }
  }

  return { drag, setDrag, phase, uploadFile };
}
