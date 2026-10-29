import { listQuoteHistory } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteRequest } from '../_http';

// GET /api/daily-quotes/history?page=1 —— 往期一言（core+，只读）。
//
// 与往期页面调用同一个服务口，只返回过去日期 + 本人状态；**不含今天**（今日内容仍要
// 先签到才能看），也不返回投稿人账号 ID、审核原因或共鸣名单。
// 页码非法（非数字 / 0 / 负数 / 越过末页）一律由服务层 normalizeQuotePage 收敛，
// 路由不自己判断 —— 页面与接口才能对同一个 page 给出同一个有效页。
export async function GET(request: Request) {
  const page = Number(new URL(request.url).searchParams.get('page'));
  return quoteRequest(async (user) => apiOk(await listQuoteHistory(user.id, page)));
}
