import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { siteOrigin } from '@/lib/site-url';
import { renderCollectPoster } from '@/lib/poster-render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/poster/collect — 自己的鱼干收款码（PNG）。
//
// **没有参数**：收款人恒为当前会话用户。收款码是要发出去让人扫码付钱的，
// 若能指定任意用户，就等于给了「批量生成他人收款码」的伪造工具
// （虽然付款页会显示真实头像昵称，但多一事不如少一事）。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const gate = rateLimit(`poster:${user.id}`, RULES.posterMinute);
  if (!gate.allowed) return apiErr(429, '生成太频繁了，请稍后再试');

  if (!siteOrigin()) return apiErr(503, '服务器未配置 SITE_URL，无法生成二维码');

  const png = await renderCollectPoster({ id: user.id, username: user.username });

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="raricy-collect.png"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
