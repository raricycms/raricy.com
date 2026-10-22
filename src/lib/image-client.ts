// ─────────────────────────────────────────────────────────────────────────────
// image-client.ts — 浏览器侧「选图 → 图床上传」的公共部分（讨论与评论共用）
//
// 【为什么单独成模块】这里的每一行都是踩出来的，复制一份必然 drift：
//   · XHR 而非 fetch —— 微信内置浏览器（Android X5 内核）对 fetch + FormData 上传有
//     已知的偶发失败（请求发不出去或 body 丢失），表现为时好时坏、而 Chrome 全绿。
//     XHR 是社区通行的绕法，各端行为一致。
//   · 网络层失败重试一次 —— 移动端弱网下第一次失败很常见，重新选图的成本远高于
//     悄悄重发一次；但 HTTP 层失败（413/403/…）**不重试**，重发还是同样结果。
//   · **上传前先按字节认一遍**（prepareImageFile）—— iPhone 的 HEIC 必须在这里转成
//     JPEG：服务端 sharp 预编译版没有 HEVC 解码器，收下 HEIC 也没法压。判定与文案
//     同源于 image-sniff.ts，服务端用的是同一份。
//
// 本文件是纯函数与常量（无 React），组件侧的状态封装见
// src/app/components/usePendingImage.ts。
// ─────────────────────────────────────────────────────────────────────────────

import {
  BITMAP_IMAGE_MIMES,
  filenameWithMimeExtension,
  isUnknownClaimedMime,
  planImageUpload,
  type ImageMime,
  type UploadRejectReason,
} from './image-sniff';

/**
 * 文件选择的 accept —— **只用于 `<input accept>`**（让 iPhone 的文件 App 里能选到原图），
 * 不参与校验：收不收看 `isUploadableImage` / `prepareImageFile`（同一份字节判定）。
 *
 * SVG 不在内联展示白名单：raw 路由对 SVG 强制 Content-Disposition: attachment
 * （防内联脚本执行的 XSS 设计），<img> 内联渲染必然失败，讨论/评论场景只收位图。
 *
 * HEIC/HEIF 是**可选的输入**而不是可入库的格式：选到之后 prepareImageFile 会就地转
 * JPEG。不写进 accept 的话，iPhone 的「文件」App 里那些原图根本选不中。
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif';

/** 讨论 / 评论 / 编辑器能直接收的位图（不含 SVG，也不含要转码的 HEIC）。 */
export const UPLOAD_IMAGE_TYPES: readonly string[] = BITMAP_IMAGE_MIMES;

/** 单文件上限（与服务端 MAX_IMAGE_SIZE 同值；这里只是先拦一道，省一次白传）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * **一次请求**的总体积上限（多文件上传用；单文件的上限是上面那个）。
 *
 * 比部署侧的两个闸门（nginx `client_max_body_size 12m`、next.config 的
 * `middlewareClientMaxBodySize: '12mb'`，见服务端 MAX_REQUEST_BYTES）低 1MB，
 * 留给 multipart 每部分的头。撞上它们的表现都很差：nginx 回 413 HTML 错误页、
 * Next 的中间件**静默截断** body（→「无效的上传请求」），两种都看不出是体积问题。
 * 所以宁可在这边先拦下，给一句能行动的提示。
 */
export const MAX_UPLOAD_REQUEST_BYTES = 11 * 1024 * 1024;

export type UploadResult =
  | { ok: true; id: string; url: string }
  | { ok: false; message: string; status: number };

/** 浏览器给不出类型时用来「猜」的后缀白名单（真正的判定仍是字节）。
 *
 * 只收**真能发出去**的那几种：`.bmp` / `.tiff` / `.avif` / `.svg` 即使名字像图片也发不出去，
 * 收进来会让批次闸门把它们算进 11MB、却在下游逐个失败 —— 正是 md-editor 那条
 * 「算进体积的必须逐条等于会被发出去的」要防的事。
 */
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|heic|heif)$/i;

/**
 * 这张图会不会被发出去（编辑器批次闸门用）。判据必须与 prepareImageFile 的接受面
 * 同源，否则会出现「算进了体积、却根本发不出去」或反向 —— 两种都会让用户看到一句
 * 与自己做的事无关的提示。
 */
export function isUploadableImage(file: File): boolean {
  if (file.size <= 0) return false;
  const type = (file.type || '').toLowerCase();
  if ((UPLOAD_IMAGE_TYPES as readonly string[]).includes(type)) return true;
  // HEIC/HEIF：会在浏览器里转码，值得放行（比转完再发现超限便宜）。
  if (isHeicFile(file)) return true;
  // 浏览器给不出类型（Windows 注册表缺项、个别安卓文件管理器、改名过的文件）：
  // 名字像图片就放行，真正的判定在 prepareImageFile 里按字节做。
  if (isUnknownClaimedMime(type || null)) return IMAGE_EXTENSION_RE.test(file.name || '');
  return false;
}

/** HEIC / HEIF（按声明类型或后缀认）。 */
export function isHeicFile(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name || '');
}

export type PreparedImage = { ok: true; file: File } | { ok: false; message: string };

/** 被拒时的文案。与服务端各写各的：图床收 SVG，讨论/评论不收，措辞本来就不同。 */
const REJECT_MESSAGES: Record<UploadRejectReason, string> = {
  unsupported: '仅支持 PNG / JPEG / GIF / WebP',
  mismatch: '文件内容与文件格式不符，或文件已损坏',
  unknown: '无法识别图片内容：文件可能已损坏，或不是图片',
  avif: '暂不支持 AVIF，请先用 /tool/convert 转成 JPEG 或 PNG',
  video: '这是视频文件。iPhone 实况照片的 .MOV 是它的动态部分，请分享其中的静态照片（HEIC / JPEG）',
};

/** 读文件头的那一小段（判定只需要前 4KB）。 */
function readBlobHead(blob: Blob, bytes: number): Promise<Uint8Array> {
  const sliced = blob.slice(0, bytes);
  // Blob.arrayBuffer 是 2019 年后的 API。老浏览器（iOS 13 时代的 Safari）只有
  // FileReader —— 不垫这一层的话，那些设备上**所有**上传都会在判定前就失败。
  if (typeof sliced.arrayBuffer === 'function') {
    return sliced.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsArrayBuffer(sliced);
  });
}

const BMP_ONLY = '仅支持 PNG / JPEG / GIF / WebP';

/**
 * 把 File 的**声明类型与后缀纠正成内容的类型**；内容没变就不复制字节。
 *
 * 为什么值得复制一次：`file.type` 会一路走到服务端的显示名与下载名，而用户把 PNG
 * 存成 `.jpg`（或浏览器给不出 type）时，纠正过来比让「jpeg 的直链其实是 PNG」更诚实。
 */
function retypeFile(file: File, mimeType: ImageMime): File {
  const name = filenameWithMimeExtension(file.name || 'image', mimeType);
  if (file.type === mimeType && name === file.name) return file;
  return new File([file], name, { type: mimeType });
}

/**
 * HEIC → JPEG（heic2any，libheif WASM）。**函数体内动态 import**：这是几百 KB 的
 * 重引擎，静态引入会把它塞进每个带图片按钮的页面主包。
 *
 * quality 取 0.92：HEIC 原图本来是有损的，再压一次的损失要压到「看不出」的量级；
 * 服务端按需还会再压一遍（compress=1 时），那是尺寸与配额的账，不靠这里省。
 */
async function convertHeicToJpeg(file: File): Promise<File> {
  const { default: heic2any } = await import('heic2any');
  const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!blob) throw new Error('HEIC 解码没有产出图像');
  return new File([blob], filenameWithMimeExtension(file.name || 'image.heic', 'image/jpeg'), {
    type: 'image/jpeg',
  });
}

/**
 * 上传前的归一化：**按字节**判定类型、纠正后缀、把 HEIC 转成 JPEG。
 *
 * 只读前 4KB（SVG 的判定窗口就是 4KB，与服务端一致）。任何一步失败都 resolve 成
 * { ok:false, message }，由调用方 toast —— 与 uploadImageFile 的错误约定一致。
 *
 * allowSvg=false（默认）：讨论 / 评论 / 编辑器只收位图，SVG 在这里就挡掉。
 * 图床页自己那份上传走 allowSvg=true（raw 路由对 SVG 走 attachment，安全）。
 */
export async function prepareImageFile(
  file: File,
  { allowSvg = false }: { allowSvg?: boolean } = {},
): Promise<PreparedImage> {
  let head: Uint8Array;
  try {
    head = await readBlobHead(file, 4096);
  } catch {
    return { ok: false, message: '读不到这个文件，请重新选择' };
  }

  const plan = planImageUpload(head, file.type);

  if (plan.kind === 'reject') return { ok: false, message: REJECT_MESSAGES[plan.reason] };

  if (plan.kind === 'accept') {
    if (plan.mimeType === 'image/svg+xml' && !allowSvg) return { ok: false, message: BMP_ONLY };
    return { ok: true, file: retypeFile(file, plan.mimeType) };
  }

  // convert-heic
  try {
    return { ok: true, file: await convertHeicToJpeg(file) };
  } catch {
    return {
      ok: false,
      message: 'HEIC 转换失败：文件可能损坏或是不支持的变体，可到 /tool/convert 再试一次',
    };
  }
}

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
 * 顺序：体积预检（省一次读盘）→ 按字节归一化（HEIC 转码 / 纠正类型）→ 体积复检
 * （转码后可能变大）→ 发请求。校验不通过时同样 resolve 成 { ok:false }（message
 * 已写好），调用方一视同仁地 toast。这里固定 compress=1（图床页那个复选框是上游
 * 唯一的「不压缩」入口，它自己拼 FormData）。
 */
export async function uploadImageFile(file: File): Promise<UploadResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 0, message: '图片不能超过 10MB' };
  }

  const prepared = await prepareImageFile(file);
  if (!prepared.ok) return { ok: false, status: 0, message: prepared.message };
  const sendFile = prepared.file;
  // 转码后复检：HEIC（有损）转 JPEG 后**可能变大**，只看原始字节会漏掉这一档。
  if (sendFile.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 0, message: '图片转换后仍超过 10MB，请先压缩或缩小尺寸' };
  }

  const fd = new FormData();
  fd.append('file', sendFile);
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
