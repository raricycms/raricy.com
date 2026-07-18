import { apiOk } from '@/lib/format';
import { getBalance } from '@/lib/fish-service';

// GET /api/fish/balance/:id — 公开接口，查询任意用户的余额（对齐 /fish/api/balance/<user_id>）。
// 无需登录，方便外部项目调用。用户不存在返回 balance: 0。
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const balance = await getBalance(id);
  return apiOk({ user_id: id, balance });
}
