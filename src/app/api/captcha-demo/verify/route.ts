import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { takeChallenge, noteFingerprint } from '@/lib/captcha-demo/store';
import {
  analyzeTrace,
  sanitizeTrace,
  traceFingerprint,
  POSITION_TOLERANCE_PX,
} from '@/lib/captcha-demo/trace';

// POST /api/captcha-demo/verify — 判定一次拖动。
//
// 【顺序是刻意的】先 takeChallenge（取走即作废），再判位置、再判行为。
//   挑战**无论判过还是判不过都已经没了** —— 重放同一份解答是滑块最经典的绕过方式。
//   别改成「判过才删」。
//
// 【位置与行为是两道独立的门】位置对了但行为判成 bot，整体仍然不通过。
//   这一条是整套的要害：位置可以被图像匹配算出来，行为才是脚本的破绽。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let body: { id?: unknown; x?: unknown; trace?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return apiErr(400, '缺少挑战 id');

  const x = body.x;
  if (typeof x !== 'number' || !Number.isFinite(x)) return apiErr(400, 'x 必须是有限数');

  // 取走即作废。用户不匹配 / 不存在 / 过期一律同一句话 —— 区分等于告诉他猜的 id 在不在
  const challenge = takeChallenge(id, user.id);
  if (!challenge) return apiErr(400, '挑战不存在或已过期');

  const dx = Math.abs(x - challenge.answerX);
  const positionOk = dx <= POSITION_TOLERANCE_PX;

  // 轨迹是不可信输入：先清洗再判。清洗不过 = 判失败（fail closed），
  // 但要与「清洗过了、分数低」分开报，否则调参会分不清是格式问题还是模型问题。
  const trace = sanitizeTrace(body.trace);
  if (!trace) {
    return apiOk({
      passed: false,
      positionOk,
      dx: Math.round(dx),
      tolerance: POSITION_TOLERANCE_PX,
      verdict: null,
      clusterSize: 0,
      traceError: '轨迹格式不合法（缺失 / 非有限数 / 时间倒流 / 超出采样上限）',
    });
  }

  const verdict = analyzeTrace(trace);
  const clusterSize = noteFingerprint(traceFingerprint(verdict.signals));

  // 行为判成 bot 就直接否掉，哪怕位置分毫不差
  const passed = positionOk && verdict.band !== 'bot';

  return apiOk({
    passed,
    positionOk,
    dx: Math.round(dx),
    tolerance: POSITION_TOLERANCE_PX,
    verdict,
    /** 同一指纹这是第几次出现。>1 说明有别的会话拖着一条一模一样的轨迹。 */
    clusterSize,
    // ⚠️ 只在演示里回下发答案：挑战上面已经作废了，说出来不构成泄漏。
    //    真上线时删掉这一行 —— 留着会让「探一次答案」变成一个坏习惯的入口。
    answerX: challenge.answerX,
  });
}
