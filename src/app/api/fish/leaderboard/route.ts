import { apiOk } from '@/lib/format';
import { getBalanceLeaderboard } from '@/lib/fish-service';

// GET /api/fish/leaderboard — 小鱼干余额排行榜（公开，无需登录）
// query: ?limit=50
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));

  const leaderboard = await getBalanceLeaderboard(limit);
  return apiOk({ leaderboard });
}
