// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tool/http-headers?url=<绝对地址>
//
// 【这是本站**唯一**代用户发起外网请求的路由】
// 其它需要联网的工具（IP 归属、DNS、二维码识别）都是**浏览器直连**第三方服务，
// 本站服务端不转发。这里必须由服务端发，是因为浏览器的 CORS 拿不到任意站点的响应头；
// 代价就是本站成了一个「出站请求发起者」，所以防护写死在这个文件与 net-guard 里。
//
// 【为什么要 SSRF 防护】攻击面不是「读别人的头」，而是**用本站当作跳板打内网**：
// `http://127.0.0.1:3000/api/...`、`http://169.254.169.254/`（云元数据）、
// 内网面板、以及「公网域名解析到 10.x」这几种写法。判据全部在
// `src/lib/dev-tools/net-guard.ts`（纯函数 + 可注入 DNS，便于单测）：
//   · 只允许 http: / https:；
//   · 端口只允许 80 / 443（默认端口也算 —— URL 解析会把默认端口吃掉）；
//   · 目标不许带用户名 / 密码；
//   · hostname 不许是 localhost / *.localhost / *.local / *.internal；
//   · IP 字面量直接判私网（不做 DNS）；
//   · 域名用 dns.lookup(host, { all: true }) 解析**全部**地址，任一是私网 / 回环 /
//     链路本地 / 保留地址就拒绝；
//   · **每一跳重定向都重新走一遍完整校验**（目标可以 302 到 127.0.0.1，只验初始
//     URL 等于没防），最多跟 MAX_REDIRECTS 次。
//
// 【为什么只允许 80 / 443】这两个端口覆盖了绝大多数公网站点；放开任意端口等于让本路由
// 能探内网的任意服务（数据库、管理面板、gopher 之类），而「查响应头」这件事不需要它们。
//
// 【为什么不读 body】本工具只需要状态码与响应头。读 body 会：
//   · 把本站变成任意大文件的下载代理（流量与内存放大）；
//   · 可能把对方的内容当作本站内容处理（编码 / 注入风险面）。
// 所以拿到 Response 后立刻 `res.body?.cancel()`，从头到尾只碰 headers。
// 同时过滤 `set-cookie`：那是对方的会话凭据，没有理由回显给任何人。
//
// 【限频】按 IP 20/分（RULES.toolHeaderFetchPerIp）。取不到 IP 时跳过该维度 ——
// 不传占位串（否则所有取不到 IP 的请求共用一个桶，见 src/lib/request-ip.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  MAX_REDIRECTS,
  TargetLookupError,
  TargetRejectedError,
  assertFetchableUrl,
} from '@/lib/dev-tools/net-guard';
import { apiErr, apiOk } from '@/lib/format';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** url 参数长度上限（任何合理网址都远小于它；更长的一律当输入错误）。 */
const MAX_URL_LENGTH = 2048;

/** 单次请求（含全部重定向跳数）的总超时。 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 出站请求的 UA：让目标站点的运维能看出请求来自本站的开发者工具，
 * 而不是某个匿名脚本。不伪装成浏览器。
 */
const OUTBOUND_USER_AGENT = 'raricy.com-dev-tools-http-headers/1.0 (+https://raricy.com/tool/dev/http-headers)';

interface RedirectHop {
  /** 发起这一跳时的地址。 */
  url: string;
  /** 这一跳收到的 3xx 状态码。 */
  status: number;
}

/** 取消响应体：本工具只读头，不下载内容。失败也忽略（连接可能已断）。 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 没有可取消的 body，或连接已经关闭 —— 两种都不影响已经拿到的响应头
  }
}

/** GET /api/tool/http-headers?url=… */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawUrl = searchParams.get('url') ?? '';

  if (!rawUrl) return apiErr(400, '缺少 url 参数');
  if (rawUrl.length > MAX_URL_LENGTH) {
    return apiErr(400, `url 参数过长（最多 ${MAX_URL_LENGTH} 个字符）`);
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return apiErr(400, 'url 参数不是合法的绝对地址（需要以 http:// 或 https:// 开头）');
  }

  // 限频：取不到 IP 时整条跳过（不传占位串，见 src/lib/request-ip.ts）。
  const ip = clientIp(req);
  if (ip) {
    const limited = rateLimit(`tool-header:ip:${ip}`, RULES.toolHeaderFetchPerIp);
    if (!limited.allowed) return apiErr(429, '请求过于频繁，请稍后再试');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const redirects: RedirectHop[] = [];
  const startedAt = Date.now();

  try {
    let current = target;
    let response: Response | null = null;

    // hop 从 0 开始：0 是初始地址，之后每一跳都是重定向目标
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertFetchableUrl(current);

      response = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: '*/*',
          'user-agent': OUTBOUND_USER_AGENT,
        },
      });

      const location =
        response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;

      // 3xx：先把这一跳的 body 关掉，再看能否继续跟
      await cancelBody(response);
      if (hop === MAX_REDIRECTS) {
        return apiErr(502, `重定向次数超过 ${MAX_REDIRECTS} 次，已停止跟踪`);
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return apiErr(502, '目标返回了无法解析的重定向地址');
      }

      redirects.push({ url: current.href, status: response.status });
      current = next;
      response = null;
    }

    if (!response) return apiErr(502, '目标站点没有返回响应');

    const finalUrl = current.href;
    const headers = [...response.headers]
      .filter(([name]) => name.toLowerCase() !== 'set-cookie')
      .map(([name, value]) => ({ name, value }));
    const result = {
      url: finalUrl,
      status: response.status,
      statusText: response.statusText,
      headers,
      redirects,
      durationMs: Date.now() - startedAt,
    };

    await cancelBody(response);
    return apiOk(result);
  } catch (e) {
    if (e instanceof TargetRejectedError) return apiErr(400, e.message);
    if (e instanceof TargetLookupError) return apiErr(502, e.message);
    if (e instanceof Error && e.name === 'AbortError') {
      return apiErr(504, `请求超时（${FETCH_TIMEOUT_MS / 1000} 秒），目标站点没有及时响应`);
    }
    return apiErr(502, '无法连接到目标站点（域名不可达、连接被拒绝或网络错误）');
  } finally {
    clearTimeout(timer);
  }
}
