// bezier.ts / curves.ts —— 动效试验台的曲线采样与曲线清单。
//
// 【这组用例钉的是什么】页面上那张曲线图、以及「逐帧递增」的数字，都靠这里现算；
// 它们必须和浏览器跑 CSS transition 时走的是同一条曲线，所以几件事必须成立：
//   · 先按 x 反解参数 t、再取该 t 处的 y。方向写反（拿 x 直接当 t）时两端仍然对，
//     只有中段会悄悄偏掉 —— 用 CSS 默认 `ease` 在 x=0.5 处的公认值 0.8024 钉住。
//   · x 是时间轴，必须夹在 [0, 1]；但 **y 不受 [0, 1] 约束**：回弹类曲线中途会冲过 1
//     再落回来，把 y 夹住会让图上的线与页面里实际动的东西对不上。
//   · `easingRange` 是图的纵向取值范围，算漏了过冲就会被裁掉 —— 与逐点采样的实测
//     极值比对。
//   · 曲线清单里的四元组必须都能被 CSS 接受（x1 / x2 出界时浏览器整条声明失效，
//     不报错，只是动画变成「瞬移」）。

import { describe, it, expect } from 'vitest';
import {
  sampleEasing,
  sampleEasingPoints,
  easingRange,
  type BezierPoints,
} from '../../src/games/motion/bezier';
import {
  MOTION_CURVES,
  curveCss,
  curveById,
  type CurveVerdict,
} from '../../src/games/motion/curves';
import {
  MOTION_SCENARIOS,
  INTERACTION_CURVE_ID,
  INTERACTION_DURATION,
} from '../../src/games/motion/scenarios';

const LINEAR: BezierPoints = [0, 0, 1, 1];
/** CSS 默认 `ease`。 */
const EASE: BezierPoints = [0.25, 0.1, 0.25, 1];
/** 交互动画：起步极快、尾巴拖长。交互产生的一切反馈统一用它。 */
const INTERACTION: BezierPoints = [0.16, 1, 0.3, 1];
/** 回弹（过冲）：y 中途超过 1。 */
const OVERSHOOT: BezierPoints = [0.34, 1.56, 0.64, 1];

/** 均匀取 n 个 x 处的采样值（含两端）。 */
function sampleYs(bezier: BezierPoints, n = 200): number[] {
  return sampleEasingPoints(bezier, n).map(([, y]) => y);
}

describe('sampleEasing（按 x 反解 t 再取 y）', () => {
  it('端点被夹住：x=0 → 0、x=1 → 1、x<0 → 0、x>1 → 1', () => {
    for (const curve of [LINEAR, EASE, INTERACTION, OVERSHOOT]) {
      expect(sampleEasing(curve, 0)).toBe(0);
      expect(sampleEasing(curve, 1)).toBe(1);
      expect(sampleEasing(curve, -0.5)).toBe(0);
      expect(sampleEasing(curve, 1.5)).toBe(1);
    }
  });

  it('回弹曲线末端正好是 1，不停在 0.999…', () => {
    // 过冲曲线若按采样值收尾，末段可能差一点点；硬端点保证它落在 1。
    expect(sampleEasing(OVERSHOOT, 1)).toBe(1);
    expect(sampleEasing(OVERSHOOT, 1 + 1e-12)).toBe(1);
  });

  it('linear [0, 0, 1, 1] 与恒等函数一致', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(sampleEasing(LINEAR, x)).toBeCloseTo(x, 6);
    }
  });

  it('CSS 默认 ease 在 x=0.5 处约为 0.8024（方向写反会偏掉）', () => {
    // 0.8024 是浏览器实现 `cubic-bezier(0.25, 0.1, 0.25, 1)` 的公认取值。
    // 若拿 x 直接当 t 去求 y，这里会得到 0.5 附近而不是 0.8。
    expect(sampleEasing(EASE, 0.5)).toBeCloseTo(0.8024, 3);
  });

  it('交互动画 [0.16, 1, 0.3, 1] 单调不减，且前 25% 已走完过半', () => {
    const ys = sampleYs(INTERACTION, 200);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-9);
    }
    // 「起步极快」这一族的判据：四分之一的时间点已经过半。
    expect(sampleEasing(INTERACTION, 0.25)).toBeGreaterThan(0.5);
  });

  it('回弹 [0.34, 1.56, 0.64, 1] 中途超过 1（y 没有被夹进 [0, 1]）', () => {
    const ys = sampleYs(OVERSHOOT, 200);
    expect(Math.max(...ys)).toBeGreaterThan(1);
    // 中段冲过头：x=0.5 已经在 1 以上（实测约 1.0874）。
    expect(sampleEasing(OVERSHOOT, 0.5)).toBeGreaterThan(1);
    // 起步仍是渐入，不会一上来就越过 1。
    expect(sampleEasing(OVERSHOOT, 0.05)).toBeLessThan(1);
    // 这条曲线直到接近末端都还在 1 上方（x=0.99 实测约 1.00014），
    // 靠 sampleEasing 的硬端点才落回正好 1 —— 这也是上一条「末端必须是 1」的意义。
    expect(sampleEasing(OVERSHOOT, 0.99)).toBeGreaterThan(1);
    expect(sampleEasing(OVERSHOOT, 1)).toBe(1);
  });
});

describe('sampleEasingPoints（图上那条折线的点集）', () => {
  it('返回 steps + 1 个点，x 从 0 到 1 严格递增', () => {
    const points = sampleEasingPoints(INTERACTION, 12);
    expect(points).toHaveLength(13);
    expect(points[0][0]).toBe(0);
    expect(points[points.length - 1][0]).toBe(1);
    for (let i = 1; i < points.length; i++) {
      expect(points[i][0]).toBeGreaterThan(points[i - 1][0]);
    }
  });

  it('首尾 y 分别是 0 与 1', () => {
    for (const curve of [LINEAR, EASE, INTERACTION, OVERSHOOT]) {
      const points = sampleEasingPoints(curve, 48);
      expect(points[0][1]).toBe(0);
      expect(points[points.length - 1][1]).toBe(1);
    }
  });

  it('默认 steps 是 48 —— 得到 49 个点', () => {
    expect(sampleEasingPoints(INTERACTION)).toHaveLength(49);
  });

  it('每一步的 y 都等于同一点上用 sampleEasing 取到的值', () => {
    for (const [x, y] of sampleEasingPoints(EASE, 8)) {
      expect(y).toBe(sampleEasing(EASE, x));
    }
  });
});

describe('easingRange（图的纵向取值范围）', () => {
  it('linear 与 ease 都落在 [0, 1] 内', () => {
    for (const curve of [LINEAR, EASE]) {
      const { min, max } = easingRange(curve);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeCloseTo(0, 9);
      expect(max).toBeCloseTo(1, 9);
    }
  });

  it('回弹的 max > 1（过冲不被裁掉）', () => {
    expect(easingRange(OVERSHOOT).max).toBeGreaterThan(1);
  });

  it('min / max 与逐点采样（200 段）的实测极值一致', () => {
    // 差在 1e-2 内：解析极值一定比采样更精确，采样漏掉峰顶时两者才会分开；
    // 分开太多说明解析求根写错了（图会被裁）。
    for (const curve of MOTION_CURVES) {
      const range = easingRange(curve.points);
      const ys = sampleYs(curve.points, 200);
      expect(range.min).toBeCloseTo(Math.min(...ys), 2);
      expect(range.max).toBeCloseTo(Math.max(...ys), 2);
      // 解析极值不可能比采样更「窄」。
      expect(range.min).toBeLessThanOrEqual(Math.min(...ys) + 1e-9);
      expect(range.max).toBeGreaterThanOrEqual(Math.max(...ys) - 1e-9);
    }
  });
});

describe('MOTION_CURVES（速度曲线清单）', () => {
  it('id 唯一', () => {
    const ids = MOTION_CURVES.map((curve) => curve.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条曲线的 x1 / x2 都在 [0, 1]（出界时浏览器整条声明失效）', () => {
    for (const curve of MOTION_CURVES) {
      const [x1, , x2] = curve.points;
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1);
      expect(x2).toBeGreaterThanOrEqual(0);
      expect(x2).toBeLessThanOrEqual(1);
    }
  });

  it('每条曲线的四元组都是有限数，且 verdict 只用三档词', () => {
    const allowed: CurveVerdict[] = ['adopt', 'candidate', 'avoid'];
    for (const curve of MOTION_CURVES) {
      expect(curve.points).toHaveLength(4);
      for (const value of curve.points) expect(Number.isFinite(value)).toBe(true);
      expect(allowed).toContain(curve.verdict);
    }
  });

  it('至少有一条 verdict === "adopt"', () => {
    expect(MOTION_CURVES.some((curve) => curve.verdict === 'adopt')).toBe(true);
  });

  it('curveById 能取回清单里的每一条（同一个对象）', () => {
    for (const curve of MOTION_CURVES) {
      expect(curveById(curve.id)).toBe(curve);
    }
  });

  it('curveById 对未知 id 抛错，错误信息带上那个 id', () => {
    expect(() => curveById('no-such-curve')).toThrow(/未知的动效曲线/);
    expect(() => curveById('no-such-curve')).toThrow(/no-such-curve/);
  });

  it('curveCss 输出形如 cubic-bezier(0.16, 1, 0.3, 1)', () => {
    expect(curveCss(curveById('interaction'))).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  });

  it('curveCss 对每一条都给出可解析的四元组', () => {
    for (const curve of MOTION_CURVES) {
      const css = curveCss(curve);
      const match = /^cubic-bezier\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)$/.exec(css);
      expect(match).not.toBeNull();
      const numbers = match!.slice(1).map(Number);
      expect(numbers).toEqual([...curve.points]);
    }
  });
});

// 「交互产生的反馈动画统一用一条曲线」这件事已经定了，所以它不能再是「碰巧对了」——
// 曲线改名、默认时长变化、某个场景忘了跟，都是静默的：页面照常渲染，只是那一格在演示
// 一条已经不用的曲线。
describe('交互动画（交互反馈的统一曲线与默认时长）', () => {
  it('清单里有一条 id / 显示名都叫「交互动画」的曲线，且被标为已采用', () => {
    const curve = curveById(INTERACTION_CURVE_ID);
    expect(curve.name).toBe('交互动画');
    expect(curve.verdict).toBe('adopt');
    expect([...curve.points]).toEqual([0.16, 1, 0.3, 1]);
  });

  it('默认时长是 600ms', () => {
    expect(INTERACTION_DURATION).toBe(600);
  });

  it('每个交互反馈场景恰有一列被标成「统一取值」，且用它自己的默认时长', () => {
    // 两格**刻意的例外**，都不属于「交互产生的反馈动画」：
    //   · progress —— 进度条的宽度就是「已完成多少」，必须匀速，否则会让人高估前期进度。
    //   · fade —— 整页切换由 docs/plan/page-transition-plan.md 单独管（只动 opacity、
    //            120–160ms），时长与统一值无关，所以它不挂「统一取值」。
    const outOfScope = new Set(['progress', 'fade']);
    for (const scenario of MOTION_SCENARIOS) {
      const adopted = scenario.variants.filter((variant) => variant.adopted === true);
      if (outOfScope.has(scenario.id)) {
        expect(adopted, `${scenario.id} 不该挂「统一取值」`).toHaveLength(0);
        continue;
      }
      expect(adopted, `${scenario.id} 的「统一取值」列数`).toHaveLength(1);
      const [variant] = adopted;
      expect(variant.curveId, `${scenario.id} 的统一列用了别的曲线`).toBe(INTERACTION_CURVE_ID);
      expect(variant.duration, `${scenario.id} 的统一列不是默认时长`).toBe(INTERACTION_DURATION);
    }
  });

  it('进度条与切页两格不跟着统一取值走（各自的规矩更硬）', () => {
    const progress = MOTION_SCENARIOS.find((scenario) => scenario.id === 'progress')!;
    expect(progress.variants[0].curveId).toBe('linear');
    for (const variant of progress.variants) expect(variant.curveId).not.toBe(INTERACTION_CURVE_ID);

    // 切页允许摆一列「统一曲线压到短时长」当对照（能直接看出在这一格统一会多慢），
    // 但它不能是「统一取值」那一列，且任何一列都不得超过 160ms 那一档太多。
    const fade = MOTION_SCENARIOS.find((scenario) => scenario.id === 'fade')!;
    for (const variant of fade.variants) {
      expect(variant.duration, `切页 ${variant.key} 超出短时长那一档`).toBeLessThanOrEqual(240);
      expect(variant.duration).toBeLessThan(INTERACTION_DURATION);
    }
  });

  it('展示标签里的 ms 数与 duration 一致（改时长忘了改文案会自相矛盾）', () => {
    for (const scenario of MOTION_SCENARIOS) {
      for (const variant of scenario.variants) {
        // 「间隔 Nms」写的是 stagger，别把它当成时长核。
        const staggerShown = /间隔\s*(\d+)ms/.exec(variant.label);
        if (staggerShown) expect(Number(staggerShown[1])).toBe(variant.stagger);
        const durationPart = variant.label.replace(/间隔\s*\d+ms/g, '');
        for (const shown of [...durationPart.matchAll(/(\d+)ms\b/g)].map((match) => Number(match[1]))) {
          expect(shown, `${scenario.id}/${variant.key} 标签写 ${shown}ms`).toBe(variant.duration);
        }
      }
    }
  });

  it('曲线清单里不再出现旧名「展开档」', () => {
    for (const curve of MOTION_CURVES) expect(curve.name).not.toContain('展开档');
    for (const scenario of MOTION_SCENARIOS) {
      for (const variant of scenario.variants) expect(variant.label).not.toContain('展开档');
    }
  });
});
