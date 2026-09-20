import fs from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_FRAME_MIME, MAX_FRAME_BYTES, resolveFrameAsset } from '@/lib/frame-service';
import { detectImageMime } from '@/lib/image-upload';

// 文件路由需 Node 运行时（fs 读盘）
export const runtime = 'nodejs';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

// GET /api/frames/:key — 从磁盘串流头像框的 PNG 字节
//
// 【刻意不做登录校验】头像框素材是**站点素材**，与表情包同性质：它不属于任何账号、
// 也不随会话变化，所以这条路由压根没有「档位」可言。**到期也不在这里判** ——
// 到期的是一条**引用**（谁在戴），不是这些字节；一个已过期的用户和一个从没拥有过的人，
// 拿到的都是同一张 PNG，判不判都一样。
//
// ⚠️ 别把这条读成「用户数据也能匿名读」的先例。全站哪些读口是有意匿名的，
//    以 tests/unit/anonymous-read-guard.test.ts 的台账为准。
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  // Next 15：params 是 Promise，不 await 拿到的是 undefined，解构直接抛
  const { key } = await ctx.params;

  // ★ 查表：key 先过白名单，才谈得上拼路径（理由见 frame-service 的安全模型）
  const hit = resolveFrameAsset(key);
  if (!hit) return notFound();

  // 纵深防御（照 sticker/[collection]/[name]/route.ts 的写法）：即便将来有人把
  // resolveFrameAsset 改成「按名字拼路径」，也出不了素材目录。
  const abs = path.resolve(hit.absPath);
  if (path.dirname(abs) !== path.resolve(hit.dir)) return notFound();

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return notFound();
  }
  if (buf.byteLength === 0 || buf.byteLength > MAX_FRAME_BYTES) return notFound();

  // ★ 扩展名只是「声明」，磁盘上的字节才是事实 ★
  //
  // 框目录没有任何上游校验（站长直接拷文件进去），所以校准必须在这里做。
  // 往目录里丢一个内容是 `<svg onload=...>` 的 demo.png，按扩展名下发的实现会以
  // image/svg+xml 内联返回 —— 那就是同源存储型 XSS。ALLOWED_FRAME_MIME 只有
  // image/png，所以这里同时拒掉了 svg / jpeg / gif / webp。
  const real = detectImageMime(buf);
  if (!real || !ALLOWED_FRAME_MIME.has(real)) return notFound();

  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': real,
      // 内容是照字节嗅探出来的，明确告诉浏览器别再自己猜
      'X-Content-Type-Options': 'nosniff',
      // 【不要 immutable】站长的工作流是「往目录里拷文件」，immutable 会让浏览器
      // 一年都不来看一眼，而且用户清了缓存也没用。1 天是折中：换图当天生效，
      // 日常零请求。与 /api/stickers/:collection/:name 同口径。
      'Cache-Control': 'public, max-age=86400',
      'X-Robots-Tag': 'all',
    },
  });
}
