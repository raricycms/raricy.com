'use client';

// ─────────────────────────────────────────────────────────────────────────────
// usePendingImage.ts — 「待发图片」的状态封装（聊天与评论共用）
//
// 状态必须留在**调用方**：发送时要把 pendingImage 的 id 一起提交，所以 ChatApp /
// CommentSection 都得看得见它。这里只把「选图 → 上传 → 落成一个待发附件 / 弹 toast」
// 这段共用逻辑收拢起来 —— 真正的重活（XHR 绕微信内核、网络层重试）在
// src/lib/image-client.ts。
//
// 单附件语义：再选一张即替换（与聊天一致）。多图是另一个量级的功能，不在本次范围。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';
import { uploadImageFile } from '@/lib/image-client';

export interface PendingImage {
  id: string;
  url: string;
}

export function usePendingImage(toast: (message: string, type: string) => void) {
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const pickImage = useCallback(
    async (file: File) => {
      setUploadingImage(true);
      try {
        const out = await uploadImageFile(file);
        if (out.ok) setPendingImage({ id: out.id, url: out.url });
        else toast(out.message, 'error');
      } finally {
        setUploadingImage(false);
      }
    },
    [toast]
  );

  const clearImage = useCallback(() => setPendingImage(null), []);

  return { pendingImage, uploadingImage, pickImage, clearImage };
}
