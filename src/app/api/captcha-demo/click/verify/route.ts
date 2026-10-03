import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { takeChallenge, noteFingerprint } from '@/lib/captcha-demo/store';
import {
  analyzeClickTrace,
  sanitizeClickTrace,
  clickFingerprint,
} from '@/lib/captcha-demo/click-trace';

// POST /api/captcha-demo/click/verify — 判定一次点选作答。
//
// 【顺序是刻意的】先 takeChallenge（取走即作废），再判位置、再判行为。
//   无论判过还是判不过，这一份挑战都已经没了 —— 重放是验证码最经典的绕过方式。
//
// 【点选天生比重放难绕过】这一点值得单独说：滑块的答案是一个数字（x），轨迹与答案
//   **相互独立**，所以录一条真人轨迹可以配任意答案反复用；点选的答案**就是点击坐标本身**，
//   与轨迹是同一份数据 —— 录下来的轨迹指向的是**上一题**那批字的位置，换一题就对不上。
//   想搬用得连坐标一起改，而改坐标就需要先解出新题 —— 绕回了「解图」这一步。
//
// 【判定与策略】位置逐点比容差；行为走 click-trace.ts，**默认只记录不拦截**
//   （BEHAVIOR_BLOCKS，理由与滑块那边同一份：误杀代价远高于漏放）。
const BEHAVIOR_BLOCKS = false;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let body: { id?: unknown; trace?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return apiErr(400, '缺少挑战 id');

  const challenge = takeChallenge(id, user.id, 'click');
  if (!challenge) return apiErr(400, '挑战不存在或已过期');

  const trace = sanitizeClickTrace(body.trace);
  if (!trace) {
    return apiOk({
      passed: false,
      positionOk: false,
      clickResults: [],
      verdict: null,
      clusterSize: 0,
      traceError: '作答格式不合法（缺失 / 非有限数 / 时间倒流 / 超出采样上限）',
    });
  }

  const expected = challenge.targets.length;
  // 点击个数对不上一律算未通过。**不在这里当作「行为可疑」**：那是没答完题，
  // 与「答了但像脚本」是两件事，混在一起会让调参时分不清。
  if (trace.clicks.length !== expected) {
    return apiOk({
      passed: false,
      positionOk: false,
      clickResults: [],
      verdict: null,
      clusterSize: 0,
      traceError: `点了 ${trace.clicks.length} 下，本题需要 ${expected} 下`,
    });
  }

  const clickResults = trace.clicks.map((c, i) => {
    const t = challenge.targets[i];
    const dx = Math.round(c.x - t.x);
    const dy = Math.round(c.y - t.y);
    const dist = Math.round(Math.hypot(dx, dy));
    return { ok: dist <= challenge.radius, dx, dy, dist };
  });
  const positionOk = clickResults.every((r) => r.ok);

  const verdict = analyzeClickTrace(trace, challenge.glyphs);
  const clusterSize = noteFingerprint(clickFingerprint(verdict.signals));

  const blockedByBehavior = verdict.band === 'bot';
  const passed = positionOk && (!BEHAVIOR_BLOCKS || !blockedByBehavior);

  return apiOk({
    passed,
    positionOk,
    clickResults,
    verdict,
    behaviorBlocks: BEHAVIOR_BLOCKS,
    blockedByBehavior,
    clusterSize,
    // ⚠️ 只在演示里回下发答案：挑战上面已经作废了，说出来不构成泄漏。
    //    真上线时删掉 —— 留着会让「探一次答案」变成一个坏习惯的入口。
    targets: challenge.targets,
    radius: challenge.radius,
  });
}
