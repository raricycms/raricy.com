import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { randomInt, randomUUID } from 'node:crypto';
import { renderScene, SCENE_W, SCENE_H } from '@/lib/captcha-demo/vision-scene';
import { buildVisionStages } from '@/lib/captcha-demo/vision-session';
import { putVisionSession, type VisionSession } from '@/lib/captcha-demo/store';

// POST /api/captcha-demo/vision/start — 开一条多阶段会话，返回第 1 阶段。
//
// 【为什么只有 POST】本站的静态守卫（tests/unit/anonymous-read-guard.test.ts）扫所有导出
//   GET / HEAD 的 route —— 那些是免认证读口，要逐个登记判据。出题要跑 sharp 渲染，
//   本来就不该是匿名读口。别顺手改成 GET。
//
// 【只下发当前这一阶段的图】会话里存的是**物体与指令**，图在这里现渲染。
//   一次把三张图都发下去等于提前交出后面几阶段的答案，见 vision-session.ts 文件头。
//
// 【下发的字段里没有答案】objects / target / source 全留在服务端。客户端只知道：
//   图长什么样、要做什么、这是第几阶段。
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  // 会话级随机种子。用 crypto 而不是 Math.random —— 出题不能被预测。
  const rng = (() => {
    let s = randomInt(1, 2 ** 31);
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  })();

  const stages = buildVisionStages(rng);
  if (!stages) {
    // 造不出「有唯一解」的题就整条重来，宁可 500 也绝不发一道有歧义的题
    return apiErr(500, '出题失败，请重试');
  }

  const id = randomUUID();
  const session: Omit<VisionSession, 'createdAt' | 'expiresAt'> = {
    kind: 'vision',
    id,
    userId: user.id,
    stages,
    index: 0,
    total: stages.length,
  };
  putVisionSession(session);

  const first = stages[0];
  const image = await renderScene(first.objects);

  return apiOk({
    sessionId: id,
    index: 0,
    total: stages.length,
    form: first.form,
    prompt: first.prompt,
    image: `data:image/png;base64,${image.toString('base64')}`,
    width: SCENE_W,
    height: SCENE_H,
  });
}
