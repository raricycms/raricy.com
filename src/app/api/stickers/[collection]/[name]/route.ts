import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALLOWED_STICKER_MIME,
  MAX_STICKER_BYTES,
  detectImageMime,
  resolveSticker,
} from '@/lib/sticker-service';

// 文件路由需 Node 运行时（fs 读盘）
export const runtime = 'nodejs';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

// GET /api/stickers/:collection/:name — 从磁盘串流表情图片字节
//
// 【刻意不做登录校验】博客对未登录读者是公开的，公开评论里嵌的表情必须也取得到
// —— 与 /api/images/[id]/raw 只对**私有图**设卡是同一个道理。这里没有「私有表情」
// 这个概念：隐藏合集（info.json 的 ignore）由 resolveSticker 拦成 404，
// 那是「不出现在面板里」，不是访问控制。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ collection: string; name: string }> }
) {
  // Next 15：params 是 Promise，不 await 拿到的是 undefined，解构直接抛
  const { collection, name } = await ctx.params;

  // ★ 查表：两段只当 map 的 key，永不拼进路径（理由见 resolveSticker 的注释）
  const hit = resolveSticker(collection, name);
  if (!hit) return notFound();

  // 纵深防御（照 avatar/[id]/route.ts 的写法）：即便将来有人把 resolveSticker 改成
  // 「按名字拼路径」，也出不了合集目录。
  const abs = path.resolve(hit.absPath);
  if (path.dirname(abs) !== path.resolve(hit.dir)) return notFound();

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return notFound();
  }
  if (buf.byteLength === 0 || buf.byteLength > MAX_STICKER_BYTES) return notFound();

  // ★ 扩展名只是「声明」，磁盘上的字节才是事实 ★
  //
  // 表情目录没有任何上游校验（图床那边有 verifyImageMime 在入口验过字节并落库，
  // raw 路由信的是库不是盘）。所以校准必须在这里做，而且**必须拒绝 SVG** ——
  // 往目录里丢一个内容是 `<svg onload=...>` 的 `开心.svg`，按扩展名下发的实现会以
  // image/svg+xml 内联返回，那就是同源存储型 XSS。
  const real = detectImageMime(buf);
  if (!real || !ALLOWED_STICKER_MIME.has(real)) return notFound();

  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': real,
      // 内容是照字节嗅探出来的，明确告诉浏览器别再自己猜
      'X-Content-Type-Options': 'nosniff',
      // 【不要 immutable】站长的工作流是「往目录里拷文件」，immutable 会让浏览器
      // 一年都不来看一眼，而且用户清了缓存也没用。1 天是折中：换图当天生效，
      // 日常零请求。
      'Cache-Control': 'public, max-age=86400',
      'X-Robots-Tag': 'all',
    },
  });
}
