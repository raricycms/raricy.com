import { listUserImages } from '@/lib/image-service';
import { getCurrentUser, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import {
  ALLOWED_MIMETYPES,
  MAX_IMAGE_SIZE,
  MAX_REQUEST_BYTES,
  getQuotaLimitMb,
  getUserUsedBytes,
  saveUpload,
  verifyImageMime,
} from '@/lib/image-upload';

// 说明：文件路由需 Node 运行时（fs / sharp）
export const runtime = 'nodejs';

// GET /api/images — 列出当前用户自己的图片元信息（需登录，排除软删）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const images = await listUserImages(user.id);
  return apiOk({
    images: images.map((img) => ({
      id: img.id,
      filename: img.filename,
      file_size: img.fileSize,
      mime_type: img.mimeType,
      author_id: img.authorId,
      author_name: img.authorName,
      created_at: img.createdAt ? img.createdAt.toISOString() : null,
      is_public: img.isPublic,
      ext: img.ext,
      url: img.url,
    })),
  });
}

/**
 * 回显给调用方的文件名 —— **保证带扩展名**。
 *
 * vditor 靠 succMap 键的扩展名决定插 `<img>` 还是普通链接（见
 * src/lib/vditor-upload.ts），而浏览器偶尔给出没有扩展名的名字（粘贴的截图、
 * 无名的 Blob）。那种名字到了 vditor 手里会被判成「非图片」→ 插图变成插链接。
 */
function displayFilename(name: string, mimeType: string): string {
  const base = name || 'image';
  if (base.includes('.')) return base;
  return `${base}.${mimeType.split('/')[1]?.replace('+xml', '') || 'png'}`;
}

// POST /api/images — multipart 二进制上传（登录 + 禁言校验）
//
// 流程复刻 Flask ImageService.upload_image：MIME 白名单 → 尺寸上限 →
// 角色配额累计 → 内存限频（75 次/时）→ sharp 压缩 → 10 位安全 ID 写盘 →
// 落库（file_size 记压缩后字节）。
//
// 【一次可以传多个】表单字段 `file` 可以重复出现 —— vditor 多选时就是这么发的
// （Flask 侧走的是 `file[]` 分支 + request.files.getlist，语义相同，只是字段名不同；
// 本站统一用 `file`，vditor 那套 succMap/errFiles 的翻译留在客户端）。逐个文件跑
// 同一条校验链：任一张不合格只让它自己进 failed，不影响同批的其它张。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法上传');

  // 角色配额为 0（user 档）在批处理**之前**拦掉：放进循环会变成 N 条
  // 「你的角色无权使用图床」，把一次 403 说成 N 次失败。
  const limitMb = getQuotaLimitMb(user.role);
  if (limitMb === 0) return apiErr(403, '你的角色无权使用图床');

  // 请求体上限预检：见 MAX_REQUEST_BYTES 的注释（nginx 回 HTML 413；Next 静默截断
  // 成「无效的上传请求」）。显式判一次，两种都变成能行动的错。
  if (Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) {
    return apiErr(413, '请求体过大，请减少一次上传的图片数量');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiErr(400, '无效的上传请求');
  }

  // 同名字段可以重复；非 File 项（客户端能塞一个叫 file 的文本字段）直接丢掉
  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) return apiErr(400, '请选择文件');

  // compress 表单字段对齐 Flask：缺省按压缩处理（Vditor/BlogForm 上传不带该字段，
  // Flask 侧 Vditor 路径默认 compress=1）；图床页复选框勾选发 '1'、取消发 '0'。
  // 【曾经的 bug】该字段被忽略，复选框取消勾选也不影响结果 —— 与 Flask 语义不符。
  // 注意它是**批级**的（一个请求一个值），不是逐文件。
  const compress = form.get('compress') !== '0';

  const limitBytes = limitMb * 1024 * 1024;
  // 已用字节在批内累加 —— 对齐 Flask 每轮重查 used 的语义。它记的是**压缩后**大小，
  // 所以只在落盘成功之后累加 saved.fileSize；累加压缩前大小会虚高、错误拒掉后面
  // 本来合法的文件（配额 50MB、已用 45MB、三张压缩后各 200KB 的截图就是例子）。
  let used = await getUserUsedBytes(user.id);

  const items: { filename: string; id: string; url: string }[] = [];
  const failed: { filename: string; message: string }[] = [];
  // 额度用尽后不再继续试：rateLimit 是「查 + 记」一体的，再调用只会一直失败。
  let rateLimited = false;

  for (const file of files) {
    const filename = displayFilename(file.name, file.type);
    const mimeType = file.type;

    if (!ALLOWED_MIMETYPES.has(mimeType)) {
      failed.push({ filename, message: '不支持的文件格式，仅允许 PNG、JPEG、GIF、WebP、SVG' });
      continue;
    }

    // 每个文件各自 try/catch：一张图炸了（磁盘满 / sharp 崩 / ID 重试耗尽）不能整批 500 ——
    // 前面的已经落盘落库了，用户重传整批只会得到重复图。也不引入事务：它盖不住磁盘写，
    // 回滚 DB 却留下孤儿文件比现状更糟。
    try {
      const buffer = Buffer.from(await file.arrayBuffer());

      // 内容校验：file.type 是浏览器声明的，可伪造。必须比对真实 magic bytes，
      // 否则「SVG/HTML 字节 + 声明 image/png」可绕过 raw 路由的 SVG attachment 分支
      // → 被浏览器嗅探为 SVG 渲染 → 同源 XSS。对齐 Flask verify_image_mime。
      if (!verifyImageMime(buffer, mimeType)) {
        failed.push({ filename, message: '文件内容与声明的格式不匹配' });
        continue;
      }

      if (buffer.length > MAX_IMAGE_SIZE) {
        failed.push({
          filename,
          message: `文件过大，单文件上限 ${Math.round(MAX_IMAGE_SIZE / (1024 * 1024))} MB`,
        });
        continue;
      }

      if (used + buffer.length > limitBytes) {
        failed.push({ filename, message: `存储空间不足，你的配额为 ${limitMb} MB` });
        continue;
      }

      // 内存限频。位置与 Flask 一致：放在全部校验之后（被拒的文件不消耗额度），
      // 且**按文件**计（Flask 的 validate_upload 每个文件消耗一次）。多张一次上传时
      // 额度用尽即止 —— 传满的那部分照常入库，没轮到的逐条说明原因，不会传一半才 429。
      if (rateLimited) {
        failed.push({ filename, message: '上传频率过高，请稍后再试' });
        continue;
      }
      const rl = rateLimit(`image-upload:${user.id}`, RULES.imageUploadHourly);
      if (!rl.allowed) {
        rateLimited = true;
        failed.push({ filename, message: '上传频率过高，请稍后再试' });
        continue;
      }

      const saved = await saveUpload({
        userId: user.id,
        buffer,
        mimeType,
        filename: file.name,
        compress,
      });
      used += saved.fileSize;
      items.push({ filename, id: saved.id, url: `/api/images/${saved.id}/raw` });
    } catch {
      failed.push({ filename, message: '图片保存失败，请重试' });
    }
  }

  // 全军覆没 → 走错误通道（单文件上传的行为与支持多文件之前逐字一致）。
  // **不能**返 200：调用方里 ImageUploader 只看 code === 200 就显示「上传成功」。
  if (items.length === 0) return apiErr(400, failed[0]?.message || '图片上传失败');

  // ⚠️ 200 / code 200 **不再等于「全部成功」** —— 看 failed 数组。所有现有调用方要么
  // 只发一个文件（图床页 / 聊天与评论选图），要么自己解析 items（vditor 编辑器），
  // 所以无害；但新调用方不许拿 code === 200 当「都传上去了」。
  // id / url 只在「恰好一个文件且零失败」时给出 —— 三个单文件调用方的契约因此逐字不变。
  return apiOk(
    {
      items,
      failed,
      ...(items.length === 1 && failed.length === 0 ? { id: items[0].id, url: items[0].url } : {}),
    },
    items.length === 1 ? '上传成功' : `成功上传 ${items.length} 张${failed.length ? `，${failed.length} 张失败` : ''}`
  );
}
