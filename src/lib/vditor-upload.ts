// ─────────────────────────────────────────────────────────────────────────────
// vditor-upload.ts — vditor 编辑器的图片上传配置（博客编辑器与云剪贴板编辑器共用）
//
// vditor 与本站各有一套「上传协议」，不显式对齐就必然出错，而且**错法都不指向根因**：
//
//   1. 字段名 —— vditor 的 IUpload.fieldName 默认是 `file[]`，而 POST /api/images 只认 `file`。
//      不写 fieldName 的后果不是「传不上去」：文件确实发出去了，是服务端 form.get('file')
//      取不到 → `400 请选择文件`。提示看着像用户没选文件，于是没人会去查请求体。
//      （2026-09 线上实际发生过：改 vditor 配置时漏了这一个字段。）
//
//   2. 响应结构 —— vditor 内置的是 ld246 那套 `{ code, msg, data: { errFiles, succMap } }`，
//      本站 /api/images 返回的是自己的结构。不翻译的话成功分支会在 genUploadedLabel 的
//      `response.data.errFiles` 上抛 TypeError（图片静默插不进去），失败分支则把整段 JSON
//      原文糊在编辑器上。所以 format（转成功）与 error（转失败）必须成对写。
//
// 两个编辑器共用这一份：复制两份必然 drift，而 drift 出来的就是上面两条里的某一条。
// 服务端只管自己的契约（一次可以带多个文件、返回 items/failed），vditor 那套结构的翻译
// **全部留在本文件**。协议细节另有一份静态契约测试：tests/unit/vditor-upload.test.ts。
// ─────────────────────────────────────────────────────────────────────────────

import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/image-client';

/** /api/images 的响应体。items/failed 是多文件上传时的新字段，见下。 */
interface UploadBody {
  code?: number;
  message?: string;
  url?: unknown;
  /** 成功的文件：{ filename, id, url } */
  items?: unknown;
  /** 失败的文件：{ filename, message } */
  failed?: unknown;
}

interface UploadEntry {
  filename?: unknown;
  message?: unknown;
  url?: unknown;
}

/**
 * 解析不出服务端文案时的兜底。两种情形都会走到：网络中断（responseText 是空串）
 * 与反代/网关拦下的错误页（HTML，压根不是我们的 JSON）。
 */
const GENERIC_UPLOAD_ERROR = '图片上传失败，请重试';

/**
 * 给重名的文件取一个不撞的键：插在**扩展名之前**（`a.png` → `a(2).png`）。
 *
 * 不能加在末尾：vditor 用 `key.lastIndexOf('.')` 取扩展名决定插 `<img>` 还是普通链接
 * （genUploadedLabel），`a.png(2)` 会被判成后者。
 * 撞键本身是真会发生的：succMap 按文件名索引，一次传两张同名图会少插一张。
 */
function uniqueKey(taken: Record<string, string>, name: string): string {
  if (!(name in taken)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${base}(${n})${ext}`;
    if (!(candidate in taken)) return candidate;
  }
}

/** 失败原因：优先逐文件的原因，其次服务端在 apiErr 里给的那句，最后兜底。 */
function failureMessage(body: UploadBody, failed: UploadEntry[]): string {
  const first = failed.find((f) => typeof f?.message === 'string' && f.message);
  if (first) return String(first.message);
  // `code !== 200` 才取 message —— 成功分支的 message 是「上传成功」，
  // 拿它当错误文案会把失败说成成功。
  if (body.code !== 200 && typeof body.message === 'string' && body.message) return body.message;
  return GENERIC_UPLOAD_ERROR;
}

/**
 * 把本站的响应翻译成 vditor 认识的结构。
 *
 * 【不要碰第一个参数】签名要求 File[]，但 vditor 运行时传进来的可能是
 * **FileList**（选择框 / 粘贴）、**DataTransferItemList**（拖拽）、或数组（录音按钮）——
 * 三者都取不到可靠的文件名（拖拽时是 `undefined`），而且它自己会先按 accept / max
 * 丢掉一部分文件，所以「客户端下标」和「服务端收到的第 n 个文件」根本对不上。
 * 键一律用**服务端回显的 items[].filename**。
 */
function formatUploadResponse(_files: unknown, responseText: string): string {
  let body: UploadBody = {};
  try {
    body = JSON.parse(responseText) as UploadBody;
  } catch {
    // 非 JSON 只可能是反代/网关的错误页 → 走下面的失败分支
  }

  const rawItems = Array.isArray(body.items) ? (body.items as UploadEntry[]) : [];
  const rawFailed = Array.isArray(body.failed) ? (body.failed as UploadEntry[]) : [];

  const succMap: Record<string, string> = {};
  for (const item of rawItems) {
    if (typeof item?.url !== 'string' || !item.url) continue;
    const name = typeof item.filename === 'string' && item.filename ? item.filename : 'image.png';
    succMap[uniqueKey(succMap, name)] = item.url;
  }

  const errFiles = rawFailed
    .map((f) => (typeof f?.filename === 'string' ? f.filename : ''))
    .filter((name) => name !== '');

  // 一张都没成 —— 也要覆盖「code 200 但 items 缺失/为空」（网关改写、服务端版本旧）。
  // msg 绝不能是空串：code 1 + 空 msg + 空 errFiles 时 vditor 会走 tip.hide()，
  // 变成**静默失败**。
  if (Object.keys(succMap).length === 0) {
    return JSON.stringify({
      code: 1,
      msg: failureMessage(body, rawFailed),
      data: { errFiles, succMap: {} },
    });
  }

  // 部分失败：code 1 + msg 让 vditor 把原因和失败文件名一起 tip 出来。
  // code 1 **不影响** succMap 的插入（genUploadedLabel 里那段是无条件执行的），
  // 所以成功的那些照样进编辑器。
  return JSON.stringify({
    code: errFiles.length > 0 ? 1 : 0,
    msg: errFiles.length > 0 ? failureMessage(body, rawFailed) : '',
    data: { errFiles, succMap },
  });
}

/**
 * 失败分支：xhr.responseText 是 apiErr 的 `{ code, message }`。
 * 网关错误页是 HTML、网络中断时是空串，两者都解析不出来 → 兜底文案。
 */
function readErrorMessage(responseText: string): string {
  try {
    const body = JSON.parse(responseText) as UploadBody;
    if (typeof body.message === 'string' && body.message) return body.message;
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
    // 多选：vditor 会把 N 个文件 append 到同一个 `file` 字段，服务端 getAll 收下。
    // （Flask 侧走的是 `file[]` 分支，语义相同，只是字段名不同。）
    multiple: true,
    // accept 只作用于选择框的过滤：vditor 自己的校验只比对 `image/` 这一级
    // （validateFile 里 type.split('/')[0]），挡不住具体格式，真正的白名单在服务端。
    // 这里不列 SVG 是有意的：raw 路由对 SVG 强制 Content-Disposition: attachment，
    // 插进文章里必然是碎图（图床页那个入口才收 SVG）。
    accept: IMAGE_ACCEPT,
    max: MAX_IMAGE_BYTES,
    /**
     * 上传前的闸门。两件事，都踩过：
     *
     * 1. **只能返回字符串来拒绝**。vditor 只在 `typeof 返回值 === 'string'` 时中止上传
     *    （dist/index.js 的 uploadFiles），返回 `false` 等于没有闸门 —— 而
     *    `types/index.d.ts` 的注释恰好写反了（「成功时返回 true 否则返回错误信息」）。
     * 2. **归一化 + 挡 null**。拖拽进来的是 DataTransferItemList，混在里面的文字/链接
     *    item 取不到 File（getAsFile() 返回 null）。multiple 打开后 vditor 会遍历每一项，
     *    null 会在它自己去读 file.name 时抛 TypeError，表现是「拖进去什么都没发生」。
     */
    validate: (files: File[]) => {
      const list: File[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const entry = files[i] as unknown;
        const file =
          entry instanceof File
            ? entry
            : ((entry as DataTransferItem | null)?.getAsFile?.() ?? null);
        if (!file) return '请拖入图片文件（文字或链接不能当图片上传）';
        list.push(file);
      }

      // 只算 vditor 真会发出去的那些：它自己会按 accept（只比对 `image/` 这一级）
      // 与 max 先筛掉一部分，把注定被丢的文件算进体积会误伤整批。
      const total = list
        .filter((f) => f.size <= MAX_IMAGE_BYTES && f.type.split('/')[0] === 'image')
        .reduce((sum, f) => sum + f.size, 0);

      if (total > MAX_UPLOAD_REQUEST_BYTES) {
        // 提示必须给动作指引：vditor 被 validate 拒时**不会**重置 input.value，
        // 用户重选同一批文件不会再触发 change，看起来就是「点了没反应」。
        return `一次最多上传 ${Math.round(MAX_UPLOAD_REQUEST_BYTES / (1024 * 1024))}MB（当前约 ${Math.ceil(total / (1024 * 1024))}MB），请分批上传`;
      }
      return true; // 放行（vditor 只认字符串为拒绝，返回 true 与 undefined 等价）
    },
    format: formatUploadResponse,
    error: (responseText: string) => onError(readErrorMessage(responseText)),
  };
}
