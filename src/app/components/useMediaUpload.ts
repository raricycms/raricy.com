'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useMediaUpload.ts — 图床 / 音频上传器共用的上传主链路
//
// 收拢的是两边**逐字相同**的那段：大小校验 → FormData → 假进度 → fetch →
// `code === 200` → 100% 停 500ms → 隐藏并回调 onUploaded()。
//
// 差异继续留在各自组件里，通过配置对象传进来（不做布尔开关）：
//   · 图床：prepare 里跑 prepareImageFile（HEIC 转 JPEG、放行 SVG）、多一个 compress 字段；
//   · 音频：不转码，只换 endpoint / accept / 文案。
//
// 三条被这里固化的既有约定，改动前先看调用方：
//   · 上传**没有**真实进度：0% → 100% 只是一段视觉反馈，停 500ms 再隐藏；
//   · 成败只看 `result.code === 200`（/api/images 的批量通道不经过本 hook）；
//   · 只处理用户选/拖的**第一份**文件。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { showToast } from './toast';

/** 上传前就地处理文件的结果（与 prepareImageFile 的返回形状一致）。 */
export type PreparedFile = { ok: true; file: File } | { ok: false; message: string };

export interface MediaUploadConfig {
  /** POST 目标，例如 '/api/images'。 */
  endpoint: string;
  /** 单文件上限（字节）。 */
  maxBytes: number;
  /**
   * 可选的就地预处理（图床的 HEIC → JPEG / SVG 放行）。返回 ok:false 即中止上传，
   * toast 里的文案由 prepare 自己给 —— 只有它知道是「格式不支持」还是「转换后仍超限」。
   */
  prepare?: (file: File) => Promise<PreparedFile>;
  /**
   * 额外表单字段。**必须是函数**：compress 复选框是非受控的，值要在提交那一刻读，
   * 渲染时读会读到上一次的值。
   */
  extraFields?: () => Record<string, string>;
  /** 成功动画走完（500ms）后调用；两个调用方都用它触发 router.refresh()。 */
  onUploaded: () => void;
}

export interface UploadProgressState {
  visible: boolean;
  width: string;
  text: string;
}

export interface MediaUploadState {
  drag: boolean;
  setDrag: (drag: boolean) => void;
  progress: UploadProgressState;
  uploadFile: (file: File) => Promise<void>;
}

const INITIAL_PROGRESS: UploadProgressState = { visible: false, width: '0%', text: '上传中...' };

export function useMediaUpload(config: MediaUploadConfig): MediaUploadState {
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<UploadProgressState>(INITIAL_PROGRESS);

  async function uploadFile(file: File) {
    // 两个入口都是 10 MB 上限，文案与之一致；改上限时同步这句。
    if (file.size > config.maxBytes) {
      showToast('文件过大，单文件上限 10 MB', 'error');
      return;
    }

    let payload = file;
    if (config.prepare) {
      const prepared = await config.prepare(file);
      if (!prepared.ok) {
        showToast(prepared.message, 'error');
        return;
      }
      payload = prepared.file;
    }

    const formData = new FormData();
    formData.append('file', payload);
    for (const [key, value] of Object.entries(config.extraFields?.() ?? {})) {
      formData.append(key, value);
    }

    setProgress({ visible: true, width: '0%', text: '上传中...' });

    try {
      const resp = await fetch(config.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      const result = await resp.json();

      if (result.code === 200) {
        setProgress((cur) => ({ ...cur, width: '100%', text: '上传成功' }));
        setTimeout(() => {
          setProgress((cur) => ({ ...cur, visible: false }));
          config.onUploaded();
        }, 500);
      } else {
        setProgress((cur) => ({ ...cur, visible: false }));
        showToast(result.message || '上传失败', 'error');
      }
    } catch {
      setProgress((cur) => ({ ...cur, visible: false }));
      showToast('网络错误，请重试', 'error');
    }
  }

  return { drag, setDrag, progress, uploadFile };
}
