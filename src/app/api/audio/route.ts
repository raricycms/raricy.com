import { listUserAudio, getUserUsedAudioBytes } from '@/lib/audio-service';
import {
  ALLOWED_AUDIO_MIMETYPES,
  MAX_AUDIO_SIZE,
  saveAudioUpload,
  verifyAudioMime,
} from '@/lib/audio-upload';
// 配额上限与请求体上限都复用图床那套实现：QUOTA_LIMITS_MB 是全站唯一一份角色额度表
// （音频只独立计量，不另立数字）；MAX_REQUEST_BYTES 对应的两个部署闸门
// （nginx client_max_body_size 12m、next.config 的 middlewareClientMaxBodySize）
// 也是**全站共享**的，而音频 10MB 与图片同值，所以共用同一个常量不会漂。
import { MAX_REQUEST_BYTES, getQuotaLimitMb } from '@/lib/image-upload';
import { getCurrentUser, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';

// 说明：文件路由需 Node 运行时（fs）
export const runtime = 'nodejs';

// GET /api/audio — 列出当前用户自己的音频元信息（需登录，排除软删）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const items = await listUserAudio(user.id);
  return apiOk({
    items: items.map((a) => ({
      id: a.id,
      filename: a.filename,
      file_size: a.fileSize,
      mime_type: a.mimeType,
      author_id: a.authorId,
      author_name: a.authorName,
      created_at: a.createdAt ? a.createdAt.toISOString() : null,
      is_public: a.isPublic,
      ext: a.ext,
      url: a.url,
    })),
  });
}

// POST /api/audio — multipart 二进制上传（登录 + 禁言校验）
//
// 流程：MIME 白名单 → 内容嗅探（**返回规范 MIME**）→ 大小上限 →
// 角色配额（**音频自己的用量聚合**）→ 内存限频（RULES.audioUploadHourly）→ 写盘 → 落库。
//
// 【一次只收一个文件】与图床刻意不同。图床支持多文件是因为 vditor 多选要那样发；
// 音频这边 10MB 单文件的量级下，「一次传多个」既用不上（一个满额文件就吃掉 1/5 配额），
// 也会更容易撞上 12MB 的请求体闸门。单文件让响应契约也简单：永远给 id/url。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 需核心用户（core 及以上）。页面挡了 core，但接口没挡 —— 未认证用户用不了界面，
  // 却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法上传');

  // 角色配额为 0（user 档）—— 与图床共用同一张 QUOTA_LIMITS_MB 表，所以闸门一致。
  const limitMb = getQuotaLimitMb(user.role);
  if (limitMb === 0) return apiErr(403, '你的角色无权使用音频床');

  // 请求体上限预检：见 image-upload.ts 的 MAX_REQUEST_BYTES 注释
  // （nginx 回 HTML 413；Next 的中间件静默截断 → multipart 解析失败）。
  if (Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) {
    return apiErr(413, '请求体过大');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiErr(400, '无效的上传请求');
  }

  const file = form.getAll('file').find((f): f is File => f instanceof File);
  if (!file) return apiErr(400, '请选择文件');

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiErr(400, '无效的上传请求');
  }

  // 内容嗅探。**这一步同时决定落库的 mimeType** —— 落库/下发用的必须是这里认过的
  // 规范值，不是浏览器声明的那个别名（`.m4a` 会被报成三种不同的 type，
  // 见 audio-upload.ts 文件头第 2 条）。
  const mimeType = verifyAudioMime(buffer, file.type, file.name);
  if (!mimeType) {
    return apiErr(
      400,
      `不支持的文件格式或内容与声明不符，仅允许 ${[...ALLOWED_AUDIO_MIMETYPES]
        .map((m) => m.replace('audio/', '').toUpperCase())
        .join('、')}`
    );
  }

  if (buffer.length > MAX_AUDIO_SIZE) {
    return apiErr(
      400,
      `文件过大，单文件上限 ${Math.round(MAX_AUDIO_SIZE / (1024 * 1024))} MB`
    );
  }

  // ★ 配额用**音频自己的聚合**，不是图床那份 ★ —— 这就是「音频独立 50MB」。
  // 额度值仍来自共用的 QUOTA_LIMITS_MB（core 50 / admin 50 / owner 100）。
  const used = await getUserUsedAudioBytes(user.id);
  if (used + buffer.length > limitMb * 1024 * 1024) {
    return apiErr(400, `存储空间不足，你的音频配额为 ${limitMb} MB`);
  }

  // 内存限频。位置在全部校验之后：被拒的文件不消耗额度。
  // ⚠️ 键前缀必须是 `audio-upload:` —— rule 不参与桶键，与图床共用前缀
  // 会让音频蹭掉图片的额度（见 rate-limit.ts 的注释）。
  const rl = rateLimit(`audio-upload:${user.id}`, RULES.audioUploadHourly);
  if (!rl.allowed) return apiErr(429, '上传频率过高，请稍后再试');

  try {
    const saved = await saveAudioUpload({
      userId: user.id,
      buffer,
      mimeType,
      filename: file.name,
    });
    return apiOk({ id: saved.id, url: `/api/audio/${saved.id}/raw` }, '上传成功');
  } catch {
    return apiErr(500, '音频保存失败，请重试');
  }
}
