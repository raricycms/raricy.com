// ─────────────────────────────────────────────────────────────────────────────
// md-editor/upload.ts —— 选文件 / 拖拽 / 粘贴进来的**多文件调度**（不碰 DOM 结构）
//
// 【与 image-client.ts 的分工】那边管「一个 File 怎么发出去」（校验 / XHR / 弱网重试），
// 这边管「一批文件怎么排队、怎么筛、超限怎么拒」。§4.3 明写 image-client「不负责选图、
// 拖拽事件、多文件调度」—— 所以那三条住在本文件，上传本身仍然复用它，一行都不另写。
//
// 【为什么是「逐个请求 + 有限并发」而不是「一个请求带 N 个文件」】
// /api/images 确实支持同名字段重复出现（那条多文件通道仍然有效，见 ImageUploader），
// 但逐个发有三个好处，且都不改变用户看到的东西：
//   · 一张图失败不连累同批其它张（服务端本来就是逐文件 try/catch，这里少一层转译）；
//   · 每个槽位天然对应一个响应，锚点的「谁完成了」是现成的，不必按文件名反查；
//   · 弱网重试的粒度是一张图，而不是「重发整批」（重发整批会得到重复图）。
// 并发上限见 MAX_CONCURRENT_UPLOADS —— 手机浏览器与微信内置浏览器同时挂七八条 XHR
// 会互相拖垮，而服务端限频也是按张计的。
//
// 【总体积闸门为什么还留着】它现在**不是**保护某个请求的体积（每个请求只有一张图），
// 而是「一次别再往下丢了」的用量提示：用户一次框选 20 张 6MB 的原图，逐个发同样会
// 把配额和限频额度一口气吃光。留的是那句能指导动作的文案，不是旧的实现形状。
// ─────────────────────────────────────────────────────────────────────────────

import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/image-client';

/**
 * 同时在飞的上传数。取 2：一条在传、一条备好，既不空等也不会把手机的连接数占满。
 * 调大只会让「谁先传完」更随机，而版面顺序已由锚点保证，与完成顺序无关。
 */
export const MAX_CONCURRENT_UPLOADS = 2;

/** 单文件是否是我们收的图片（与服务端白名单同一份 accept）。 */
export function isAcceptableImage(file: File): boolean {
  return IMAGE_ACCEPT.split(',').includes(file.type) && file.size > 0;
}

/**
 * 把选择框 / 拖拽 / 粘贴给的东西归一化成 File[]。
 *
 * 拖拽进来的是 DataTransferItemList：里面的**文字、链接 item 取不到 File**
 * （getAsFile() 返回 null）。必须在这里挡掉 —— 后面拿到的 `.name` / `.size` 全在
 * 它身上，漏一个就是一次 TypeError（表现为「拖进去什么都没发生」）。
 *
 * `nonFileCount` 让调用方区分「一个文件都没有」与「拖进来的是文字/链接」
 * —— 前者静默（拖错了位置），后者要给一句提示。
 */
export function normalizeDroppedFiles(items: ArrayLike<unknown>): {
  files: File[];
  nonFileCount: number;
} {
  const files: File[] = [];
  let nonFileCount = 0;
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i];
    const file =
      entry instanceof File
        ? entry
        : ((entry as DataTransferItem | null)?.getAsFile?.() ?? null);
    if (file) files.push(file);
    else nonFileCount += 1;
  }
  return { files, nonFileCount };
}

/** `一次最多上传 11MB（当前约 12MB），请分批上传` —— 与旧实现逐字一致。 */
function batchTooLargeMessage(total: number): string {
  return `一次最多上传 ${Math.round(MAX_UPLOAD_REQUEST_BYTES / (1024 * 1024))}MB（当前约 ${Math.ceil(total / (1024 * 1024))}MB），请分批上传`;
}

export type BatchGate = { ok: true; files: File[] } | { ok: false; message: string };

/**
 * 上传前的闸门：先按单文件口径筛，再看总体积。
 *
 * 只把**确实会发出去的那些**算进体积：远超单文件上限的、非图片的，本来就会在
 * 下一步被逐条拒掉，把它们算进来会让一整批本来合法的图被误伤。
 * 但它们**不是被悄悄丢掉** —— 调用方要为每个被筛掉的文件留一个失败槽位，
 * 这样用户看到的是「第 3 张太大了」，而不是「选了 3 张只进来 2 张」。
 */
export function gateUploadBatch(candidates: File[]): BatchGate {
  if (candidates.length === 0) return { ok: true, files: [] };
  const sendable = candidates.filter(
    (f) => f.size <= MAX_IMAGE_BYTES && f.type.split('/')[0] === 'image'
  );
  const total = sendable.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_UPLOAD_REQUEST_BYTES) return { ok: false, message: batchTooLargeMessage(total) };
  return { ok: true, files: candidates };
}

/** 逐文件的前置校验（与 image-client.uploadImageFile 的前两句同一口径）。 */
export function precheckFile(file: File): string | null {
  if (file.size > MAX_IMAGE_BYTES) return `图片不能超过 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`;
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) return '仅支持 PNG / JPEG / GIF / WebP';
  return null;
}

/**
 * 有限并发的任务泵。`worker` 拿到 (item, index)，自行吞掉异常 ——
 * 这个泵不收集结果（结果由每个 worker 自己落到锚点槽位上）。
 */
export function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve();
      return;
    }
    let next = 0;
    let running = 0;
    let finished = 0;
    const pump = () => {
      while (running < limit && next < items.length) {
        const index = next;
        next += 1;
        running += 1;
        void worker(items[index], index).then(() => {
          running -= 1;
          finished += 1;
          if (finished === items.length) resolve();
          else pump();
        });
      }
    };
    pump();
  });
}

/**
 * 插入用的标准 Markdown：`![文件名](url)` 后跟一个换行 —— **换行在每一张后面都有**，
 * 单张也一样，且不因张数分支。这条形状是**刻意的**：正文里同一张图在「上传插入」与
 * 「资源面板挑选」两条路上必须逐字一致（面板那次读的就是这个函数），少一个换行就会
 * 让两次插入在并排的两行里粘成一行。
 *
 * 文件名取**服务端回显的那个**（带扩展名）：浏览器偶尔给不出名字（粘贴的截图、
 * 匿名 Blob），服务端会按 MIME 补一个，比我们自己猜可靠。
 */
export function imageMarkdown(filename: string, url: string): string {
  return `![${filename}](${url})\n`;
}
