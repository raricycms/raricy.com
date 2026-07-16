import { listUserImages } from '@/lib/image-service';
import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import {
  ALLOWED_MIMETYPES,
  MAX_IMAGE_SIZE,
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

// POST /api/images — multipart 二进制上传（登录 + 禁言校验）
//
// 流程复刻 Flask ImageService.upload_image：MIME 白名单 → 尺寸上限 →
// 角色配额累计 → 内存限频（75 次/时）→ sharp 压缩 → 10 位安全 ID 写盘 →
// 落库（file_size 记压缩后字节）。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法上传');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiErr(400, '无效的上传请求');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return apiErr(400, '请选择文件');

  const mimeType = file.type;
  if (!ALLOWED_MIMETYPES.has(mimeType)) {
    return apiErr(400, '不支持的文件格式，仅允许 PNG、JPEG、GIF、WebP、SVG');
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 内容校验：file.type 是浏览器声明的，可伪造。必须比对真实 magic bytes，
  // 否则「SVG/HTML 字节 + 声明 image/png」可绕过 raw 路由的 SVG attachment 分支
  // → 被浏览器嗅探为 SVG 渲染 → 同源 XSS。对齐 Flask verify_image_mime。
  if (!verifyImageMime(buffer, mimeType)) {
    return apiErr(400, '文件内容与声明的格式不匹配');
  }

  if (buffer.length > MAX_IMAGE_SIZE) {
    return apiErr(400, `文件过大，单文件上限 ${Math.round(MAX_IMAGE_SIZE / (1024 * 1024))} MB`);
  }

  const limitMb = getQuotaLimitMb(user.role);
  if (limitMb === 0) return apiErr(403, '你的角色无权使用图床');

  const used = await getUserUsedBytes(user.id);
  const limitBytes = limitMb * 1024 * 1024;
  if (used + buffer.length > limitBytes) {
    return apiErr(400, `存储空间不足，你的配额为 ${limitMb} MB`);
  }

  // 内存限频（放在全部校验之后，避免被拒的请求消耗额度）
  const rl = rateLimit(`image-upload:${user.id}`, RULES.imageUploadHourly);
  if (!rl.allowed) return apiErr(429, '上传频率过高，请稍后再试');

  const saved = await saveUpload({
    userId: user.id,
    buffer,
    mimeType,
    filename: file.name,
  });

  return apiOk({ id: saved.id, url: `/api/images/${saved.id}/raw` }, '上传成功');
}
