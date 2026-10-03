// ─────────────────────────────────────────────────────────────────────────────
// synthetic.ts — 演示脚手架：合成两条「机器人轨迹」，让人当场看到判定器的对照。
//
// 【它不是攻击代码】这里干的事**不碰任何真实接口**，只是造一份 samples 数组、
//   交给 verify 去判。演示的就是「脚本会把什么样的数据发到服务端」—— 让判定器的
//   能力边界变成肉眼可见的东西，而不是一句「它能识别脚本」。
//
//   两个档位是刻意拉开跨度的：
//     naive —— 定时器等距采样、直线、y 零抖动、落点即松手。**每个破绽都命中一条规则。**
//     smart —— 缓动曲线、真实抖动、起手有延迟、落点有回抽。**几乎全部躲过。**
//   后者才代表真实对手，它拿 90 分就是这套启发式的天花板：**分数高不等于人**。
//
// 【确定性】两条都用固定种子的 LCG，不用 Math.random —— 这样同一档位跑两次，
//   轨迹逐字节相同，指纹也会撞上，于是演示里能看到 clusterSize 涨到 2。
//   这正是跨会话指纹要抓的东西：单条像人，但**两百条一模一样**。
// ─────────────────────────────────────────────────────────────────────────────

import type { TraceSample, TraceMeta, TraceInput } from '@/lib/captcha-demo/trace';

export type SyntheticMode = 'naive' | 'smart';

export interface SyntheticRun extends TraceInput {
  /** 拖动结束时滑块停在哪 —— 组件要把它同步到界面上，看着才像真拖过。 */
  finalOffset: number;
}

/** 固定种子的 LCG：跨次运行逐字节可复现，见文件头。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 合成事件在浏览器看来仍是「可信」的（CDP 驱动的真浏览器就是如此），所以不伪造 isTrusted。 */
const META_BASE: Omit<TraceMeta, 'endMs'> = { pointerType: 'mouse', allTrusted: true };

/**
 * 朴素脚本：等距定时器 + 完美直线 + y 锁死 + 起手立即 + 落点即松手。
 * 期望：判成 bot。
 */
function naive(maxOffset: number): SyntheticRun {
  const n = 40;
  const durMs = 900;
  const target = Math.round(maxOffset * 0.55);
  const samples: TraceSample[] = [];
  for (let i = 0; i <= n; i++) {
    samples.push({
      t: (i * durMs) / n, // 间隔恒为 22.5ms —— dt 变异系数正好是 0
      x: (target * i) / n,
      y: 420, // 常量 —— 标准差 0
    });
  }
  return {
    samples,
    meta: { ...META_BASE, endMs: durMs }, // settleMs = 0
    finalOffset: target,
  };
}

/**
 * 老练脚本：缓动曲线 + 抖动 + 起手延迟 + 末端回抽。
 * 期望：**拿高分（接近 human）** —— 这就是这套启发式的天花板。
 */
function smart(maxOffset: number): SyntheticRun {
  const rng = makeRng(20261003);
  const n = 60;
  const target = Math.round(maxOffset * 0.55);
  const samples: TraceSample[] = [];

  let t = 200; // 起手延迟 200ms（人不会 0ms 就动）
  samples.push({ t, x: 0, y: 420 + (rng() - 0.5) * 1.2 });

  const xs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const frac = i / n;
    xs.push(target * (1 - Math.pow(1 - frac, 3))); // ease-out cubic
  }
  // 末端过冲 + 回抽：制造方向反转（人类几乎必然有）
  xs.push(target + 7);
  xs.push(target + 1);
  xs.push(target);

  for (let i = 1; i < xs.length; i++) {
    t += 8 + rng() * 24; // 间隔 8–32ms，变异系数约 0.35
    samples.push({ t, x: xs[i], y: 420 + (rng() - 0.5) * 1.2 });
  }

  return {
    samples,
    meta: { ...META_BASE, endMs: t + 45 }, // 松手前停顿 45ms
    finalOffset: target,
  };
}

export function buildSyntheticTrace(mode: SyntheticMode, maxOffset: number): SyntheticRun {
  return mode === 'naive' ? naive(maxOffset) : smart(maxOffset);
}
