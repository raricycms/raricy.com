import { listUserImages } from '@/lib/image-service';
import { getCurrentUser, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { UploadQuotaError } from '@/lib/upload-quota';
import {
  MAX_IMAGE_SIZE,
  MAX_REQUEST_BYTES,
  filenameWithMimeExtension,
  getQuotaLimitMb,
  getUserUsedBytes,
  planImageUpload,
  saveUpload,
  type UploadRejectReason,
} from '@/lib/image-upload';

// 说明：文件路由需 Node 运行时（fs / sharp）
export const runtime = 'nodejs';

/**
 * 内容判定被拒时的文案（**对外契约**，改之前看 docs/bot/image-bot.md 的错误表）。
 *
 * 分得这么细是有原因的：原来所有「不是合格图片」都回同一句「文件内容与声明的格式
 * 不匹配」，而 iPhone 用户看到这句话时手里明明是一张照片 —— 因为 HEIC 既不是白名单
 * 格式、内容也认不出。三种情况要分别给出**能照着做**的动作：
 *   · HEIC → 先转 JPEG（站内格式转换器 / 图床页面会自动转）；
 *   · MOV → 那是实况照片的动态部分，不是图片；
 *   · AVIF → 转换器可转。
 */
const REJECT_MESSAGES: Record<UploadRejectReason | 'heic', string> = {
  unsupported: '不支持的文件格式，仅允许 PNG、JPEG、GIF、WebP、SVG',
  mismatch: '文件内容与声明的格式不匹配',
  unknown: '无法识别图片内容：文件可能已损坏，或不是图片',
  heic: '这是 iPhone 的 HEIC/HEIF 格式，服务端不收；请先转成 JPEG 再上传（图床页面与编辑器会自动转，也可以走 /tool/convert）',
  avif: '暂不支持 AVIF，请先转成 JPEG / PNG（/tool/convert 可转）',
  video: '这是视频文件，图床只收静态图片。iPhone 实况照片的 .MOV 是它的动态部分，请改传同一张照片的静态图（HEIC / JPEG）',
};

// GET /api/images — 列出当前用户自己的图片元信息（需登录，排除软删）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 需核心用户（core 及以上）。
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

// POST /api/images — multipart 二进制上传（登录 + 禁言校验）
//
// 上传流程：内容判定（image-sniff 的 planImageUpload，**以字节为准**）→ 尺寸上限 →
// 角色配额累计 → 内存限频（RULES.imageUploadHourly，**按张计**）→ sharp 压缩 →
// 10 位安全 ID 写盘 → 落库（file_size 记压缩后字节）。
//
// 【一次可以传多个】表单字段 `file` 可以重复出现 —— **用同名重复字段表达多选**，
// 不另造 `files[]` 那种形状。逐个文件跑同一条校验链：任一张不合格只让它自己进
// failed，不影响同批的其它张。（现行调用方多是一张一个请求，见 md-editor/upload.ts
// 「为什么是逐个请求而不是一个请求带 N 个文件」；这条多文件通道仍然有效。）
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 需核心用户（core 及以上）。
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

  // compress 表单字段：**缺省按压缩处理** —— 编辑器上传（md-editor/upload.ts）与
  // 讨论 / 评论选图都不带这个字段，它们要的就是压缩后的图；只有图床页有那个复选框，
  // 勾选发 '1'、取消发 '0'。
  // 【曾经的 bug】该字段被忽略，复选框取消勾选也不影响结果 —— 与「缺省即压缩」不符。
  // 注意它是**批级**的（一个请求一个值），不是逐文件。
  const compress = form.get('compress') !== '0';

  const limitBytes = limitMb * 1024 * 1024;
  // 已用字节在批内累加 —— 每张图都按「同批前面已落盘的量」判配额，不另查库。它记的是**压缩后**大小，
  // 所以只在落盘成功之后累加 saved.fileSize；累加压缩前大小会虚高、错误拒掉后面
  // 本来合法的文件（配额 50MB、已用 45MB、三张压缩后各 200KB 的截图就是例子）。
  let used = await getUserUsedBytes(user.id);

  const items: { filename: string; id: string; url: string }[] = [];
  const failed: { filename: string; message: string }[] = [];
  // 额度用尽后不再继续试：rateLimit 是「查 + 记」一体的，再调用只会一直失败。
  let rateLimited = false;

  for (const file of files) {
    // 被拒的文件回显**用户自己给的名字**，不按声明纠正：Safari 常把 HEIC 报成
    // image/jpeg，按声明补后缀会让失败列表显示 `IMG_0001.jpg`，而用户选的是 `.HEIC`
    // —— 报错时名字必须诚实，否则用户找不到自己那张图。
    const displayName = file.name || 'image';

    // 每个文件各自 try/catch：一张图炸了（磁盘满 / sharp 崩 / ID 重试耗尽）不能整批 500 ——
    // 前面的已经落盘落库了，用户重传整批只会得到重复图。也不引入事务：它盖不住磁盘写，
    // 回滚 DB 却留下孤儿文件比现状更糟。
    try {
      const buffer = Buffer.from(await file.arrayBuffer());

      // 内容判定：声明是浏览器（甚至攻击者）说了算的提示值，**落库类型只认字节**。
      // HEIC 走 convert-heic（服务端没有 HEVC 解码器，只能由浏览器先转成 JPEG），
      // 实况照片的 .MOV 走 video —— 各自回一句能照着做的提示。
      const plan = planImageUpload(buffer, file.type);
      if (plan.kind !== 'accept') {
        failed.push({
          filename: displayName,
          message: REJECT_MESSAGES[plan.kind === 'convert-heic' ? 'heic' : plan.reason],
        });
        continue;
      }

      const mimeType = plan.mimeType;
      // 名字与**内容**对齐：PNG 存成 .jpg 的、没有扩展名的，这里纠正/补齐。
      const filename = filenameWithMimeExtension(file.name, mimeType);

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

      // 内存限频。位置刻意放在全部校验之后：被拒的文件不消耗额度，
      // 用户改对重试时不会被刚才那几次失败挡住。且**按文件**计（每张各消耗一次）。多张一次上传时
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
        filename,
        compress,
        quotaBytes: limitBytes,
      });
      used += saved.fileSize;
      items.push({ filename, id: saved.id, url: `/api/images/${saved.id}/raw` });
    } catch (error) {
      failed.push({ filename: displayName, message: error instanceof UploadQuotaError
        ? `存储空间不足，你的配额为 ${limitMb} MB` : '图片保存失败，请重试' });
    }
  }

  // 全军覆没 → 走错误通道（单文件上传的行为与支持多文件之前逐字一致）。
  // **不能**返 200：调用方里 ImageUploader 只看 code === 200 就显示「上传成功」。
  if (items.length === 0) return apiErr(400, failed[0]?.message || '图片上传失败');

  // ⚠️ 200 / code 200 **不再等于「全部成功」** —— 看 failed 数组。现有调用方要么
  // 只发一个文件（图床页 / 讨论与评论选图 / 编辑器上传），要么自己解析 items
  // （ImageUploader 的批量入口），所以无害；但新调用方不许拿 code === 200 当「都传上去了」。
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
