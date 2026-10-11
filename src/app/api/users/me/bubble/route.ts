import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { equipBubble, listMyBubbles } from '@/lib/bubble-service';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  return apiOk(await listMyBubbles(user.id));
}
export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('bubble_key' in body)) {
    return apiErr(400, '缺少 bubble_key（恢复默认请显式传 null）');
  }
  const key = body.bubble_key;
  if (key !== null && typeof key !== 'string') return apiErr(400, 'bubble_key 必须是字符串或 null');
  const result = await equipBubble(user.id, key);
  if (!result.ok) return apiErr(result.code, result.message);
  return apiOk({ bubble_key: result.key, expires_at: result.expiresAt?.toISOString() ?? null });
}
