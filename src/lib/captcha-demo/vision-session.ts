// ─────────────────────────────────────────────────────────────────────────────
// vision-session.ts — 把「多阶段视觉空间任务」串成一条会话。
//
// ── 难度是按梯度排的，不是随机的 ────────────────────────────────────────────
//
//   第 1 阶段 simple   —— 按属性筛唯一命中。热身，让人先看懂玩法。
//   第 2 阶段 relative —— 先解参照物、再比方位。**必须两步都对**。
//   第 3 阶段 drag     —— 同时定位两个物体（拖哪个、拖到哪）。
//
// 这让 p^n 里的每个 p 都不同，而不是同一个 p 连乘三次。
//
// ── 会话存物体，**不存图** ──────────────────────────────────────────────────
//
// 图在「服务到那一阶段」时才渲染（见 step 路由）。若建会话时就把三张图都渲染好、
// 一次发给客户端，那等于把后面几阶段的答案一起送出去了 —— 前端扒一下 `next` 数组
// 就能提前知道该点哪。**别为了省一次渲染把它改成一并下发。**
// ─────────────────────────────────────────────────────────────────────────────

import { generateScene } from './vision-scene';
import { makeInstruction, renderInstruction } from './vision-task';
import type { VisionStage } from './store';

export type StageForm = 'simple' | 'relative' | 'drag';

/** 难度梯度。改这里就等于改 p^n 里每个 p。 */
export const DEFAULT_PLAN: StageForm[] = ['simple', 'relative', 'drag'];

/** 单阶段最多试几次能造出「有唯一解」的指令。实测平均 1~2 次就成。 */
const MAX_TRIES = 40;

export function buildVisionStages(
  rng: () => number,
  plan: StageForm[] = DEFAULT_PLAN
): VisionStage[] | null {
  const stages: VisionStage[] = [];
  for (const form of plan) {
    let built: VisionStage | null = null;
    for (let t = 0; t < MAX_TRIES && !built; t++) {
      const objects = generateScene(rng);
      const made = makeInstruction(objects, rng, form);
      if (!made) continue;
      built = {
        objects,
        instruction: made.instruction,
        prompt: renderInstruction(made.instruction),
        // 点击型：要点中的那个就是 answer。拖拽型：answer 是要拖走的、drop 是落点。
        target: made.drop ?? made.answer,
        source: made.drop ? made.answer : null,
        form,
      };
    }
    if (!built) return null; // 造不出就整条会话重来，绝不发一道有歧义的题
    stages.push(built);
  }
  return stages;
}
