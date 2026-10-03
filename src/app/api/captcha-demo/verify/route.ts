import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { takeChallenge, noteFingerprint } from '@/lib/captcha-demo/store';
import {
  analyzeTrace,
  sanitizeTrace,
  traceFingerprint,
  POSITION_TOLERANCE_PX,
} from '@/lib/captcha-demo/trace';

/**
 * 行为判定是否参与拦截。**默认 false —— 只记录、不拦截。**
 *
 * 这是刻意的部署姿态，不是半成品。三条理由：
 *
 *   1. **本站误杀的代价远高于漏放。** 用户全是同一个学校的同学，一次误杀会直接
 *      找到站长；而漏放只是少挡一次。两类错误的权重根本不对等。
 *   2. **阈值是估的，没校准过。** trace.ts 头部写着「权重全是拍的」—— 拿没校准的
 *      阈值去拦真人，等于拿同学做实验。
 *   3. **已经真的误杀过一次。** 站长实测「我自己试经常会出现瞬移步」，那条特征
 *      （maxStep/medianStep）机器人都抓不到、专抓真人，已删除。这就是没校准的
 *      阈值会干出什么事。
 *
 * 先按 false 跑一段，用真实数据把阈值调出来再翻。翻成 true 之前至少要：
 *   · 回放站内真人的历史轨迹，按误杀率定标；
 *   · 重审 flatY —— 桌面端鼠标横向直拖，y 就是逐像素恒定的，那条对真人不友好。
 */
const BEHAVIOR_BLOCKS = false;

// POST /api/captcha-demo/verify — 判定一次拖动。
//
// 【顺序是刻意的】先 takeChallenge（取走即作废），再判位置、再判行为。
//   挑战**无论判过还是判不过都已经没了** —— 重放同一份解答是滑块最经典的绕过方式。
//   别改成「判过才删」。
//
// 【三道门，都要过】位置命中 + 行为不判 bot + 轨迹终点自洽。
//
// ── 三道门各自挡得住谁（**别高估**） ──────────────────────────────────────────
//
//   · **位置**：挡的是「直接 POST 一个瞎猜的 x」。图像匹配仍然能算出来（加固只抬高
//     了它的成本，见 puzzle-image.ts 头部），所以它不是墙。
//   · **行为**：挡的是「脚本直接算坐标、一次性 set 到位」。
//     ⚠️ **它挡不住鼠标模拟库**：Playwright / pyautogui 这类驱动的是真浏览器，
//     产出的是 isTrusted=true 的**真事件**、真实时间戳 —— `allTrusted` 那条只抓得到
//     页面内 `dispatchEvent` 伪造的低级货。真要用模拟鼠标过，唯一露馅的地方是
//     **运动曲线本身**（Playwright 默认的匀速直线就是 trace.ts 里的 naive，必被抓），
//     而人味曲线是能合成的。所以这一门的实质是「逼攻击者去跑真浏览器 + 写曲线」。
//   · **轨迹自洽**：挡的是「录一次真人轨迹、两百个账号反复重放」。见下面的 lastX 检查。
//
//   三道加起来仍然**不是不可绕过**，但它们把「一次 curl」抬成了「一个带浏览器农场、
//   会算图、会合成人味轨迹的系统」—— 这就是本项目要的「提高攻击者成本」。
//   真正扛批量的是**跨会话指纹聚类**（clusterSize）：单条能伪造，两百条一模一样很难。
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
  const challenge = takeChallenge(id, user.id, 'slider');
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

  // 【重放闸】轨迹的终点必须就是提交上来的那个 x。
  //   真客户端**必然**满足 —— onPointerUp 提交的正是最后一次采样记下的 offset。
  //   所以失配只有一种来源：这份轨迹是从**别的挑战**录下来重放的
  //   （录的时候终点是旧答案，现在提交的是新答案）。
  //   容差 3px 留给浮点与取整，不是留给攻击者的。
  //   ⚠️ 它只挡得住**原样重放**。攻击者把轨迹里的 x 整体缩放/平移一下就能绕过 ——
  //   那时挡住他的是指纹聚类（clusterSize），不是这一条。别以为这条是重放的解药。
  const lastX = trace.samples[trace.samples.length - 1].x;
  const trajectoryConsistent = Math.abs(lastX - x) <= 3;

  // 行为判成 bot 时**按当前策略默认不拦截** —— 见 BEHAVIOR_BLOCKS
  const blockedByBehavior = verdict.band === 'bot';
  const passed = positionOk && trajectoryConsistent && (!BEHAVIOR_BLOCKS || !blockedByBehavior);

  return apiOk({
    passed,
    positionOk,
    dx: Math.round(dx),
    tolerance: POSITION_TOLERANCE_PX,
    verdict,
    /** 轨迹终点与提交的 x 是否自洽（false = 这份轨迹是从别处录来重放的）。 */
    trajectoryConsistent,
    /** 行为判定当前是否参与拦截（= BEHAVIOR_BLOCKS 常量）。 */
    behaviorBlocks: BEHAVIOR_BLOCKS,
    /** 这一次**是否会被**行为判定拦下 —— 拦截关着时它只是观察值，别当 passed 用。 */
    blockedByBehavior,
    /** 同一指纹这是第几次出现。>1 说明有别的会话拖着一条一模一样的轨迹。 */
    clusterSize,
    // ⚠️ 只在演示里回下发答案：挑战上面已经作废了，说出来不构成泄漏。
    //    真上线时删掉这一行 —— 留着会让「探一次答案」变成一个坏习惯的入口。
    answerX: challenge.answerX,
  });
}
