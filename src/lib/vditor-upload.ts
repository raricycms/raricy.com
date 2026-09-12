// ─────────────────────────────────────────────────────────────────────────────
// vditor-upload.ts — vditor 编辑器的图片上传配置（博客编辑器与云剪贴板编辑器共用）
//
// vditor 与本站各有一套「上传协议」，不显式对齐就必然出错，而且**两种错法都不指向根因**：
//
//   1. 字段名 —— vditor 的 IUpload.fieldName 默认是 `file[]`，而 POST /api/images 只认 `file`。
//      不写 fieldName 的后果不是「传不上去」：文件确实发出去了，是服务端 form.get('file')
//      取不到 → `400 请选择文件`。提示看着像用户没选文件，于是没人会去查请求体。
//      （2026-09 线上实际发生过：改 vditor 配置时漏了这一个字段。）
//
//   2. 响应结构 —— vditor 内置的是 ld246 那套 `{ code, msg, data: { errFiles, succMap } }`，
//      本站 /api/images 返回 `{ code: 200, message, id, url }`。不写 format 的话成功分支会在
//      genUploadedLabel 的 `response.data.errFiles` 上抛 TypeError（图片静默插不进去），
//      失败分支则把整段 JSON 原文糊在编辑器上。所以 format（转成功）与 error（转失败）
//      必须成对写 —— 只写一个等于把另一个坑留着。
//
// 两个编辑器共用这一份：复制两份必然 drift，而 drift 出来的就是上面两条里的某一条。
// ─────────────────────────────────────────────────────────────────────────────

import { IMAGE_ACCEPT, MAX_IMAGE_BYTES } from '@/lib/image-client';

/** /api/images 的响应体（成功分支与失败分支共用一个形状）。 */
interface UploadBody {
  code?: number;
  message?: string;
  url?: unknown;
}

/**
 * 解析不出服务端文案时的兜底。两种情形都会走到：网络中断（responseText 是空串）
 * 与反代/网关拦下的错误页（HTML，压根不是我们的 JSON）。
 */
const GENERIC_UPLOAD_ERROR = '图片上传失败，请重试';

/**
 * vditor 按 succMap **键的扩展名**决定插入什么（图片 / 音频 / 普通链接），
 * 所以键必须是带扩展名的原始文件名 —— 给 id 或 URL 会让它插入一条普通链接。
 */
function uploadedFileName(file: File | undefined): string {
  if (!file) return 'image.png';
  if (file.name.includes('.')) return file.name;
  // 极少见：截图粘贴在部分浏览器里没有文件名。按 MIME 补个扩展名，
  // 否则 vditor 取不到后缀，判断不出该插入 <img> 还是链接。
  const ext = (file.type.split('/')[1] || 'png').replace('+xml', '');
  return `${file.name || 'image'}.${ext}`;
}

/**
 * 成功分支：把 apiOk 的响应翻译成 vditor 认识的结构。
 *
 * 【入参的真实类型】签名写着 File[]，vditor 运行时传的其实是 **FileList**
 * （uploadFiles 收的是 `<input type=file>` 的 `event.target.files`）。
 * 所以这里只能按下标取，用 `files.slice()` / `files.map()` 会
 * `TypeError: e.slice is not a function` —— 而且它抛在 vditor 的
 * onreadystatechange 里，表现是「接口 200、图片没插进去、提示停在『上传中…』」（实测踩过）。
 *
 * 服务端一次只收一个文件（route 里 `form.get('file')` 只取第一个），multiple: false 时
 * vditor 自己也已经把文件截到 1 个（uploadFiles 的 filesMax = 1），故这里只看 files[0]。
 */
function formatUploadResponse(files: File[], responseText: string): string {
  let body: UploadBody = {};
  try {
    body = JSON.parse(responseText) as UploadBody;
  } catch {
    // 非 JSON 只可能是反代/网关的错误页 → 走下面的失败分支
  }

  if (body.code !== 200 || typeof body.url !== 'string') {
    return JSON.stringify({
      code: 1,
      msg: body.message || GENERIC_UPLOAD_ERROR,
      data: { errFiles: [], succMap: {} },
    });
  }

  return JSON.stringify({
    code: 0,
    msg: '',
    data: { errFiles: [], succMap: { [uploadedFileName(files[0])]: body.url } },
  });
}

/**
 * 失败分支：xhr.responseText 是 apiErr 的 `{ code, message }`。
 * 网关错误页是 HTML、网络中断时是空串，两者都解析不出来 → 兜底文案。
 */
function readErrorMessage(responseText: string): string {
  try {
    const body = JSON.parse(responseText) as UploadBody;
    if (body.message) return body.message;
  } catch {
    // 见上
  }
  return GENERIC_UPLOAD_ERROR;
}

/**
 * 上传配置。onError 由调用方决定怎么提示（对齐 image-client.ts 的分工：
 * 库只管协议，不弹 toast、不碰状态）。
 */
export function vditorUploadOptions(onError: (message: string) => void): IUpload {
  return {
    url: '/api/images',
    // 不写就是 vditor 的默认值 `file[]`，服务端取不到 → 400 请选择文件
    fieldName: 'file',
    // 服务端一次只收一个（form.get('file') 只返回第一个）——关掉多选，
    // 别让选择框看起来像能一次传一叠
    multiple: false,
    // accept 只作用于选择框的过滤：vditor 自己的校验只比对 `image/` 这一级
    // （validateFile 里 type.split('/')[0]），挡不住具体格式，真正的白名单在服务端。
    // 这里不列 SVG 是有意的：raw 路由对 SVG 强制 Content-Disposition: attachment，
    // 插进文章里必然是碎图（图床页那个入口才收 SVG）。
    accept: IMAGE_ACCEPT,
    max: MAX_IMAGE_BYTES,
    format: formatUploadResponse,
    error: (responseText: string) => onError(readErrorMessage(responseText)),
  };
}
