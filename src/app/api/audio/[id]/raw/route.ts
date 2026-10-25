import fs from 'node:fs/promises';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { getAudioForServe } from '@/lib/audio-service';
import { audioStoragePathFor } from '@/lib/audio-upload';
import {
  PRIVATE_BYTES_CACHE_CONTROL,
  PUBLIC_BYTES_CACHE_CONTROL,
  ifNoneMatchMatches,
  weakFileEtag,
} from '@/lib/http-cache';

// 文件路由需 Node 运行时（fs 读盘）
export const runtime = 'nodejs';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audio/:id/raw — 从磁盘串流音频字节（**支持 HTTP Range**）
//
// 【为什么 Range 在这里是硬需求，不是优化】图床那条 raw 路由整文件下发就够用 ——
// 图片没有「拖进度条」这回事。音频有，而且比那更硬：
//   · 播放器拖动进度必须靠 `206 Partial Content`；
//   · **Safari 会先发 `Range: bytes=0-1` 探测**，拿不到 206 就直接不播 ——
//     不是「不能拖」，是根本放不出来。移动端 Safari 尤其如此。
// 所以下面这段不能省，也不能「先全量以后再补」。
//
// 【为什么不用 ReadableStream】仓库里那两处流（chat/stream、notifications/stream）
// 是无界 SSE，**刻意没有 Content-Length**，形状与这里正好相反。
// 本路由的硬需求恰恰是那个 Content-Length：没有它，播放器不知道这一段有多少字节，
// 拖动会以「浏览器行为很怪」的形式坏掉。而单文件上限 10MB，
// 在单进程站点上直接把这一段读进内存最简单、也最不容易错。
//
// 【安全】与图床同形：ignore → 404；私有档对无权者伪装成不存在。
// 内容类型取**落库的** mimeType —— 那是上传时 verifyAudioMime 认过的规范值，
// 不是浏览器当初声明的别名。
//
// 【缓存】与图床同一条口径（`public, no-cache` + 弱 ETag，见 src/lib/http-cache.ts）：
// 删除是软删，同一个 URL 会变 404，所以不能发 immutable 长缓存 —— 否则已经听过
// 的访客永远听得到一条已删除的录音，且没有任何报错。200 / 206 都带同一个 ETag，
// 未变化回 304（零字节），删了回 404。
// ─────────────────────────────────────────────────────────────────────────────

function notFound(): Response {
  // 404 不能被缓存：不存在 / 已软删 / 私有档伪装三合一，且「已软删」正是删音频的
  // 正常反馈 —— 被记住之后访客连问都不问。
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/** 严格解析非负整数：`NaN` 与溢出都返回 null（见下面 parseRange 的说明）。 */
function parseNonNegInt(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  // 超大数字串会变成不精确的浮点（1e21 之类），夹住它
  return Number.isSafeInteger(n) ? n : null;
}

type RangeResult =
  | { kind: 'none' } // 没给 / 畸形 / 多段 → 按全量 200 处理
  | { kind: 'ok'; start: number; end: number } // 206
  | { kind: 'unsatisfiable' }; // 416

/**
 * 解析 `Range` 头。**任何情况下都不抛异常** —— 畸形头导致 500 会让一次媒体请求
 * 变成服务器错误，而正确行为是「当没给 Range」。
 *
 * 三种形态：`bytes=A-B` / `bytes=A-` / `bytes=-N`（后缀，取最后 N 字节）。
 *
 * ⚠️ 两个刻意的不做：
 *   · **多段**（`bytes=0-99,200-299`）直接当没给。按 RFC 那要回
 *     `multipart/byteranges`，播放器不用它，徒增一条没人测的代码路径。
 *   · **不认识的长度单位**照 RFC 忽略（当没给），不报错。
 *
 * ⚠️ 这里不用 `parseInt` 裸判：`parseInt('abc')` 是 `NaN`，而 `NaN` 参与的所有比较
 * 都是 false —— 于是「start 不合法」会安静地变成「start = 0」或「全程」，
 * 既不是 200 也不是 416，是一个没人定义过的响应。一律先过 `^\d+$`。
 */
function parseRange(header: string | null, total: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(.*)$/i.exec(header.trim());
  if (!m) return { kind: 'none' };
  const spec = m[1].trim();
  if (spec.includes(',')) return { kind: 'none' };
  const dash = spec.indexOf('-');
  if (dash < 0) return { kind: 'none' };

  const startRaw = spec.slice(0, dash).trim();
  const endRaw = spec.slice(dash + 1).trim();

  // 空文件：任何 Range 都无法满足（否则下面会算出 end = -1）
  if (total === 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;

  if (startRaw === '') {
    // 后缀形 `bytes=-N`：最后 N 字节
    const n = parseNonNegInt(endRaw);
    if (n === null) return { kind: 'none' };
    if (n === 0) return { kind: 'unsatisfiable' }; // RFC 7233：`-0` 不可满足
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    const s = parseNonNegInt(startRaw);
    if (s === null) return { kind: 'none' };
    if (endRaw === '') {
      start = s;
      end = total - 1;
    } else {
      const e = parseNonNegInt(endRaw);
      if (e === null) return { kind: 'none' };
      if (e < s) return { kind: 'none' }; // 倒序 → 无效，当没给
      start = s;
      end = Math.min(e, total - 1); // 末端超出要夹住，不是错误
    }
    if (start >= total) return { kind: 'unsatisfiable' };
  }

  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'ok', start, end };
}

/** 只读 [start, end] 这一段字节，不把整个文件读进内存。 */
async function readSlice(filePath: string, start: number, end: number): Promise<Buffer> {
  const len = end - start + 1;
  const buf = Buffer.alloc(len);
  const fh = await fs.open(filePath, 'r');
  try {
    let filled = 0;
    // 常规文件通常一次就读满，但 read 允许短读 —— 循环到读满或 EOF 为止
    while (filled < len) {
      const { bytesRead } = await fh.read(buf, filled, len - filled, start + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    return filled === len ? buf : buf.subarray(0, filled);
  } finally {
    await fh.close();
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const audio = await getAudioForServe(id);
  if (!audio || audio.ignore) return notFound();

  if (audio.isPublic === false) {
    const user = await getCurrentUser();
    if (!user || (user.id !== audio.authorId && !hasAdminRights(user))) {
      return notFound(); // 私有音频对无权访问者伪装成不存在
    }
  }

  const filePath = audioStoragePathFor(audio.id, audio.mimeType);
  let total: number;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(filePath);
    total = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return notFound();
  }

  // 公开音频的条件请求：**先验证、命中就 304**，只有真要下发字节时才读盘。
  // 删除一定赢 —— 上面的 getAudioForServe 已经把软删挡成 404，所以哪怕客户端
  // 带着完全匹配的 ETag 回来，也拿不到 304。
  // 私有音频没有条件请求可言（no-store，且绝不能把「作者能听」这个判断结果
  // 按 ETag 缓存出去）。
  //
  // ⚠️ 带着 `Range` 的验证请求同样走 304 —— RFC 9110 §13.1.3 规定 If-None-Match
  // 先于 Range 求值，缓存用自己已经存下的段来满足这次请求。播放器拖进度条时
  // 发的就是这种请求。
  const etag = audio.isPublic ? weakFileEtag({ size: total, mtimeMs }) : null;
  if (etag && ifNoneMatchMatches(req.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': PUBLIC_BYTES_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'all',
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const range = parseRange(req.headers.get('range'), total);

  if (range.kind === 'unsatisfiable') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        'Content-Range': `bytes */${total}`,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  const start = range.kind === 'ok' ? range.start : 0;
  const end = range.kind === 'ok' ? range.end : total - 1;
  const isPartial = range.kind === 'ok';

  let data: Buffer;
  try {
    data = await readSlice(filePath, start, end);
  } catch {
    return notFound();
  }

  const headers = new Headers({
    'Content-Type': audio.mimeType,
    // 禁止浏览器 MIME 嗅探：即便有字节被塞进错误的 Content-Type，也不会被当成
    // 别的类型渲染。与上传侧的 magic byte 校验互为兜底。
    'X-Content-Type-Options': 'nosniff',
    // 告诉播放器可以按段取 —— 缺它有些客户端会放弃拖动
    'Accept-Ranges': 'bytes',
    // 私有档绝不能进共享缓存（CDN / 反代 / 中间缓存），否则鉴权形同虚设：
    // 缓存命中后会绕过本路由的作者/管理员校验，直接向无权者下发。
    //
    // 公开档是 `public, no-cache`，**200 与 206 同一口径** —— 不能给 200 发长缓存、
    // 给 206 发短的（旧写法正是如此）：那会诱使中间缓存拿一个残段去满足后续的全量
    // 请求，是经典的「媒体文件下坏了」成因，而症状只是播放器莫名其妙失败。
    // 现在两档都靠 ETag 验证：未变化 304、删了 404。
    'Cache-Control': !audio.isPublic
      ? PRIVATE_BYTES_CACHE_CONTROL
      : PUBLIC_BYTES_CACHE_CONTROL,
    // robots.txt 里 /api/ 整段 disallow，只给几个前缀开了口（见 src/app/robots.ts）——
    // 那是**按路径**放行，粒度不到单个文件。私有文件必须逐个挡掉。
    'X-Robots-Tag': audio.isPublic ? 'all' : 'noindex',
    'Content-Length': String(data.length),
  });
  // 200 与 206 必须带**同一个** ETag：播放器会拿全量请求拿到的 ETag 去验证后续
  // 的分段请求，两边不一致就永远不会命中 304（表现只是「每次都在重下」）。
  if (etag) headers.set('ETag', etag);

  // 刻意**不设 Content-Disposition**：音频是用来内联播放的。
  // 图床那边只对 SVG 强制 attachment（防内联执行脚本），这三种音频格式没有那条路径。
  if (isPartial) {
    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
  }

  return new Response(new Uint8Array(data), { status: isPartial ? 206 : 200, headers });
}
