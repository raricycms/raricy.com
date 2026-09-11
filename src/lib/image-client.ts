// ─────────────────────────────────────────────────────────────────────────────
// image-client.ts — 浏览器侧「选图 → 图床上传」的公共部分（聊天与评论共用）
//
// 【为什么单独成模块】这里的每一行都是踩出来的，复制一份必然 drift：
//   · XHR 而非 fetch —— 微信内置浏览器（Android X5 内核）对 fetch + FormData 上传有
//     已知的偶发失败（请求发不出去或 body 丢失），表现为时好时坏、而 Chrome 全绿。
//     XHR 是社区通行的绕法，各端行为一致。
//   · 网络层失败重试一次 —— 移动端弱网下第一次失败很常见，重新选图的成本远高于
//     悄悄重发一次；但 HTTP 层失败（413/403/…）**不重试**，重发还是同样结果。
//
// 本文件是纯函数与常量（无 React），组件侧的状态封装见
// src/app/components/usePendingImage.ts。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 文件选择的 accept —— 与上传前的 MIME 校验共用这一份。
 *
 * SVG 不在内联展示白名单：raw 路由对 SVG 强制 Content-Disposition: attachment
 * （防内联脚本执行的 XSS 设计），<img> 内联渲染必然失败，聊天/评论场景只收位图。
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/** 单文件上限（与服务端 MAX_IMAGE_SIZE 同值；这里只是先拦一道，省一次白传）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type UploadResult =
  | { ok: true; id: string; url: string }
  | { ok: false; message: string; status: number };

/**
 * 上传图片到图床（POST /api/images，multipart）。
 *
 * 只在**网络层**失败时 reject（onerror/onabort）；HTTP 状态码一律 resolve，
 * 让调用方决定是重试还是把服务端文案展示给用户。
 */
function uploadImage(fd: FormData): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images'); // 同源 → 会话 cookie 自动带上
    xhr.onload = () => {
      let body: { code?: number; message?: string; id?: unknown; url?: unknown } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // 非 JSON 只可能是反代/网关的错误页（413/502/…）→ 用状态码兜底
      }
      if (
        xhr.status === 200 &&
        body.code === 200 &&
        typeof body.id === 'string' &&
        typeof body.url === 'string'
      ) {
        resolve({ ok: true, id: body.id, url: body.url });
      } else {
        resolve({
          ok: false,
          status: xhr.status,
          message: body.message || `图片上传失败（HTTP ${xhr.status}）`,
        });
      }
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('abort'));
    xhr.send(fd);
  });
}

/**
 * 校验 + 上传一个用户选中的文件。**不弹 toast、不碰状态** —— 由调用方决定怎么反馈。
 *
 * 校验不通过时同样 resolve 成 { ok:false }（message 已写好），调用方一视同仁地 toast。
 * compress=1 对齐 Flask 的 Vditor 上传路径（图床页那个复选框是另一个入口）。
 */
export async function uploadImageFile(file: File): Promise<UploadResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 0, message: '图片不能超过 10MB' };
  }
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) {
    return { ok: false, status: 0, message: '仅支持 PNG / JPEG / GIF / WebP' };
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('compress', '1');
  try {
    return await uploadImage(fd);
  } catch {
    // 网络层失败（请求没发出去 / 连接被中断）重试一次：移动端弱网、微信内置浏览器里
    // 第一次失败很常见，而重新选图的成本远高于悄悄重发一次。HTTP 层失败走的是
    // resolve，不重试 —— 重发还是同样结果。
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await uploadImage(fd);
    } catch {
      return { ok: false, status: 0, message: '图片上传失败：网络中断，请重试' };
    }
  }
}
