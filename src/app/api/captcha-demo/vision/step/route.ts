import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { renderScene, SCENE_W, SCENE_H } from '@/lib/captcha-demo/vision-scene';
import {
  getVisionSession,
  dropVisionSession,
  type VisionStage,
  type VisionSession,
} from '@/lib/captcha-demo/store';
import {
  judgeClick,
  SHAPE_LABEL,
  COLOR_LABEL,
  type SceneObject,
} from '@/lib/captcha-demo/vision-task';

// POST /api/captcha-demo/vision/step — 交一阶段的答案。
//
// 【全或无】答错**立刻终止整条会话**（dropVisionSession），不给人重试本阶段的机会。
//   这是 p^n 的地基：若每阶段允许重试，攻击者每阶段的成功率就从 p 抬到 1-(1-p)²，
//   串起来之后 p^n 的优势会被吃掉一大半。代价是真人错一次要重来 —— 用手感换安全，
//   而界面必须把「这是第几关」写得很清楚，别让人不明不白地重来。
//
// 【防乱序 / 防重放】请求必须带上它以为的阶段号，与会话里的下标对不上就拒。
//   否则客户端可以把同一个阶段的答案重复提交，或者跳过某阶段。
//
// 【失败时告诉用户他点到的是哪个图形】会话已经作废了，说出来不构成泄漏，
//   而真人确实需要这个反馈才知道自己是「没看懂题」还是「手抖点歪了」。

function label(o: SceneObject): string {
  const size = o.size === 0 ? '小' : o.size === 1 ? '中等' : '大';
  return `${size}${SHAPE_LABEL[o.kind]}（${COLOR_LABEL[o.color]}）`;
}

function stagePayload(session: VisionSession, stage: VisionStage, image: Buffer) {
  return {
    sessionId: session.id,
    index: session.index,
    total: session.total,
    form: stage.form,
    prompt: stage.prompt,
    image: `data:image/png;base64,${image.toString('base64')}`,
    width: SCENE_W,
    height: SCENE_H,
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  let body: {
    sessionId?: unknown;
    index?: unknown;
    x?: unknown;
    y?: unknown;
    from?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return apiErr(400, '缺少 sessionId');

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(body.x);
  const y = num(body.y);
  const index = num(body.index);
  if (x === null || y === null || index === null) return apiErr(400, '坐标或阶段号不合法');

  const session = getVisionSession(sessionId, user.id);
  if (!session) return apiErr(400, '会话不存在或已过期');
  if (index !== session.index) return apiErr(400, '阶段号与当前进度不符');

  const stage = session.stages[session.index];

  // 拖拽型要同时判起点与落点：起点必须是 src，落点必须是 dst。
  // 只判落点的话，「原地随便一拖」也可能蒙对。
  let ok: boolean;
  let nearest: SceneObject;
  let dist: number;
  if (stage.form === 'drag') {
    const fr = body.from as { x?: unknown; y?: unknown } | undefined;
    const fx = num(fr?.x);
    const fy = num(fr?.y);
    if (fx === null || fy === null) return apiErr(400, '拖拽型必须给起点');
    const a = judgeClick(stage.objects, stage.source!, fx, fy);
    const b = judgeClick(stage.objects, stage.target, x, y);
    ok = a.ok && b.ok;
    nearest = b.nearest;
    dist = b.dist;
  } else {
    const r = judgeClick(stage.objects, stage.target, x, y);
    ok = r.ok;
    nearest = r.nearest;
    dist = r.dist;
  }

  if (!ok) {
    dropVisionSession(session.id);
    return apiOk({
      stagePassed: false,
      done: true,
      passed: false,
      failedAt: session.index,
      total: session.total,
      /** 给真人的反馈：你碰到的是这个图形。会话已作废，说出来不构成泄漏。 */
      youHit: label(nearest),
      wantHint: stage.form === 'drag' ? '两个端点都要落在正确的图形上' : '要求点中的是另一个图形',
    });
  }

  session.index += 1;
  if (session.index >= session.total) {
    dropVisionSession(session.id);
    return apiOk({ stagePassed: true, done: true, passed: true, total: session.total });
  }

  const next = session.stages[session.index];
  const image = await renderScene(next.objects);
  return apiOk({
    stagePassed: true,
    done: false,
    next: stagePayload(session, next, image),
  });
}
