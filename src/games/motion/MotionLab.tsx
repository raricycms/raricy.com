'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { sampleEasing, sampleEasingPoints, easingRange } from './bezier';
import {
  MOTION_CURVES,
  TAIL_CURVES,
  curveCss,
  curveById,
  type MotionCurve,
} from './curves';
import {
  MOTION_SCENARIOS,
  TAIL_SCENARIOS,
  INTERACTION_CURVE_ID,
  INTERACTION_DURATION,
  type MotionScenario,
  type MotionVariant,
  type ScenarioKind,
} from './scenarios';
import TailDropdown from './TailDropdown';
import { useReducedMotion } from './use-reduced-motion';

// 动效试验台：同一个场景摆几列，除「哪条曲线、走多久」以外完全一样。
//
// 两个刻意的取舍：
//   · 时长与曲线由**内联 CSS 自定义属性**传下去（`--mo-duration` / `--mo-easing`），
//     样式表里只写兜底值。这样往 curves.ts / scenarios.ts 里加一条变体只改数据，
//     不用碰样式表 —— 试验台的价值全在「改一行数据就多一列」。
//   · 「重播」靠换 key 重挂载元素：CSS 动画只在元素入场时跑一次，改属性不会重放。
//     重挂载让关键帧从头来，也让这一列自己的状态（面板开合、滑块位置）一起归零。

/** 曲线图的坐标框：100 × 100 见方，四周留 pad 给过冲曲线与描边。 */
const PLOT_SIZE = 100;
const PLOT_PAD = 6;
const SPARK_HEIGHT = 36;

/**
 * 全部曲线的纵向取值范围。过冲那条中途会到 1.0978，按 [0, 1] 裁掉的话图上那条线
 * 顶部会被切平，看起来像「到顶就停」，与实际动画不符。
 */
const PLOT_RANGE = (() => {
  let min = 0;
  let max = 1;
  for (const curve of MOTION_CURVES) {
    const range = easingRange(curve.points);
    min = Math.min(min, range.min);
    max = Math.max(max, range.max);
  }
  return { min, max };
})();

/** 把 [x, y] 点集折成 SVG path；主图与每列的小图共用这一套映射。 */
function toPath(points: readonly [number, number][], height: number) {
  const usableX = PLOT_SIZE - PLOT_PAD * 2;
  const usableY = height - PLOT_PAD * 2;
  const span = PLOT_RANGE.max - PLOT_RANGE.min || 1;
  return points
    .map(([x, y], index) => {
      const px = PLOT_PAD + x * usableX;
      const py = height - PLOT_PAD - ((y - PLOT_RANGE.min) / span) * usableY;
      return `${index === 0 ? 'M' : 'L'}${px.toFixed(2)} ${py.toFixed(2)}`;
    })
    .join(' ');
}

function motionStyle(curve: MotionCurve, duration: number): CSSProperties {
  return { '--mo-duration': `${duration}ms`, '--mo-easing': curveCss(curve) } as CSSProperties;
}

function verdictLabel(curve: MotionCurve) {
  // 统一的交互曲线要说得比「已采用」更肯定 —— 它是这一轮定下来的那一条。
  if (curve.id === INTERACTION_CURVE_ID) return '已统一采用';
  if (curve.verdict === 'adopt') return '已采用';
  if (curve.verdict === 'avoid') return '不建议';
  return '候选';
}

// ── 曲线总览 ─────────────────────────────────────────────────────────────────

function CurveOverview({ picked, onPick }: { picked: string | null; onPick: (id: string | null) => void }) {
  // 对角虚线是匀速参照 —— 每个点都落在 y = x 上。
  const diagonal = useMemo(() => toPath(sampleEasingPoints([0, 0, 1, 1], 4), PLOT_SIZE), []);
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => PLOT_PAD + ratio * (PLOT_SIZE - PLOT_PAD * 2));

  return (
    <section className="mo-overview" aria-labelledby="mo-overview-title">
      <figure className="mo-overview__figure">
        <svg className="mo-overview__plot" viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`} role="img" aria-label="全部备选速度曲线的形状对比">
          <rect className="mo-plot__frame" x="0.4" y="0.4" width="99.2" height="99.2" rx="4" />
          {gridLines.map((position) => (
            <g key={position}>
              <line className="mo-plot__grid" x1={position} y1={PLOT_PAD} x2={position} y2={PLOT_SIZE - PLOT_PAD} />
              <line className="mo-plot__grid" x1={PLOT_PAD} y1={position} x2={PLOT_SIZE - PLOT_PAD} y2={position} />
            </g>
          ))}
          <path className="mo-plot__diagonal" d={diagonal} />
          {MOTION_CURVES.map((curve) => (
            <path
              key={curve.id}
              className={[
                'mo-plot__path',
                `mo-plot__path--${curve.verdict}`,
                picked ? (curve.id === picked ? 'mo-plot__path--pick' : 'mo-plot__path--dim') : null,
              ].filter(Boolean).join(' ')}
              d={toPath(sampleEasingPoints(curve.points, 40), PLOT_SIZE)}
            />
          ))}
        </svg>
        <figcaption className="mo-overview__caption">
          横轴是时间进度、纵轴是实际走了多少。对角虚线是匀速，贴左上角的是「起步极快」。
          点下面任一条可以单独把它挑出来看。
        </figcaption>
      </figure>

      <div>
        <h2 id="mo-overview-title">备选曲线</h2>
        <ul className="mo-legend">
          {MOTION_CURVES.map((curve) => (
            <li key={curve.id}>
              <button
                type="button"
                className={`mo-legend__item${curve.id === picked ? ' is-active' : ''}`}
                aria-pressed={curve.id === picked}
                onClick={() => onPick(curve.id === picked ? null : curve.id)}
              >
                <span className={`mo-legend__swatch mo-legend__swatch--${curve.verdict}`} aria-hidden="true" />
                <span className="mo-legend__body">
                  <span className="mo-legend__name">
                    {curve.name}
                    <span className="mo-legend__badge">{verdictLabel(curve)}</span>
                  </span>
                  <code className="mo-legend__css">{curveCss(curve)}</code>
                  <span className="mo-legend__note">{curve.note}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── 短尾曲线族 ───────────────────────────────────────────────────────────────

/**
 * 把一条曲线画成「墙钟时间 → 行程」：横轴是 0–540ms 里的实际时刻，曲线只画到自己时长，
 * 之后留白 —— 留白那一段就是这档**不再等**的时间。几档短尾因此前段重叠、末端错开。
 */
function wallClockPoints(curve: MotionCurve, duration: number, steps = 48): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index <= steps; index++) {
    const u = index / steps;
    points.push([(u * duration) / INTERACTION_DURATION, sampleEasing(curve.points, u)]);
  }
  return points;
}

/**
 * 「尾巴长度」的图：五条曲线按**实际时间**叠在同一张坐标里。
 *
 * 妙的地方是四条短尾按「前段墙钟位置贴着现版」拟合，所以它们几乎完全重合；区别
 * 只在线的末端 —— 现版画到 540ms，短尾分别在 480 / 420 / 360 / 300ms 收住。
 * 用虚线区分四条短尾，图例里的色块是同一段虚线，圆点标出各自的结束时刻。
 */
function TailFamilySection() {
  const baseline = curveById(INTERACTION_CURVE_ID);
  const entries = [
    { curve: baseline, duration: INTERACTION_DURATION },
    ...TAIL_CURVES.map((curve) => ({ curve, duration: curve.duration })),
  ];
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => PLOT_PAD + ratio * (PLOT_SIZE - PLOT_PAD * 2));
  const diagonal = useMemo(() => toPath(sampleEasingPoints([0, 0, 1, 1], 4), PLOT_SIZE), []);

  return (
    <section className="mo-tail" aria-labelledby="mo-tail-title">
      <div className="mo-tail__intro">
        <h2 className="mo-tail__title" id="mo-tail-title">尾巴长度：让动画真的更早结束</h2>
        <p className="mo-tail__lead">
          交互动画 540 有两处拖：整段一直拖到最后，而且最后 5% 的行程要磨约 310ms。下面四档
          把收尾直接砍短 —— 每档有自己的真实时长（<strong>480 / 420 / 360 / 300ms</strong>，
          到点就真的结束），曲线参数则按「前段墙钟位置贴着现版」拟合：前 200ms 里实时位置
          与现版差不超过约 2%，50% 在 55–56ms 走到（现版 55ms）。最后 5% 的行程因此从 310ms
          依次降到约 256 / 201 / 146 / 88ms。四条都是正常的三次贝塞尔，整条曲线连续可导。
        </p>
      </div>

      <figure className="mo-tail__figure">
        <svg className="mo-tail__plot" viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`} role="img" aria-label="交互动画与四档更早结束的曲线按实际时间的对比">
          <rect className="mo-plot__frame" x="0.4" y="0.4" width="99.2" height="99.2" rx="4" />
          {gridLines.map((position) => (
            <g key={position}>
              <line className="mo-plot__grid" x1={position} y1={PLOT_PAD} x2={position} y2={PLOT_SIZE - PLOT_PAD} />
              <line className="mo-plot__grid" x1={PLOT_PAD} y1={position} x2={PLOT_SIZE - PLOT_PAD} y2={position} />
            </g>
          ))}
          <path className="mo-plot__diagonal" d={diagonal} />
          {entries.map(({ curve, duration }, index) => {
            const points = wallClockPoints(curve, duration);
            const end = points[points.length - 1];
            const className = index === 0 ? 'mo-plot__path mo-plot__path--adopt' : `mo-plot__path mo-plot__path--candidate mo-tail__line mo-tail__line--${index}`;
            return (
              <g key={curve.id}>
                <path className={className} d={toPath(points, PLOT_SIZE)} />
                <circle className={`mo-tail__end ${index === 0 ? 'mo-tail__end--base' : `mo-tail__end--${index}`}`} cx={PLOT_PAD + end[0] * (PLOT_SIZE - PLOT_PAD * 2)} cy={PLOT_SIZE - PLOT_PAD - (end[1] - PLOT_RANGE.min) / (PLOT_RANGE.max - PLOT_RANGE.min) * (PLOT_SIZE - PLOT_PAD * 2)} r="1.6" />
              </g>
            );
          })}
        </svg>
        <figcaption className="mo-overview__caption">
          横轴是实际时间（0–540ms）、纵轴是实际走了多少。几条线前段几乎完全重合（同一时刻
          位置差约 2% 以内），区别只在末端：现版画到 540ms 才停，短尾依次在 480 / 420 / 360 /
          300ms 收住 —— 圆点是各自的结束时刻，右侧留白就是省掉的那段缓冲。
        </figcaption>
      </figure>

      <ul className="mo-tail__legend">
        {entries.map(({ curve, duration }, index) => (
          <li key={curve.id} className="mo-tail__item">
            <svg className="mo-tail__swatch" viewBox="0 0 24 8" aria-hidden="true">
              <line
                className={index === 0 ? 'mo-tail__line mo-tail__line--base' : `mo-tail__line mo-tail__line--${index}`}
                x1="1"
                y1="4"
                x2="23"
                y2="4"
              />
            </svg>
            <span className="mo-tail__body">
              <span className="mo-tail__name">
                {curve.name}
                <span className="mo-tail__badge">
                  {duration < INTERACTION_DURATION ? `早 ${INTERACTION_DURATION - duration}ms 结束` : '现版 540ms'}
                </span>
              </span>
              <span className="mo-tail__note">{curve.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── 各场景的舞台 ─────────────────────────────────────────────────────────────

/**
 * 展开面板：0fr → 1fr，按内容真实高度伸展。
 *
 * 「重播」在这里不能靠换 key 重挂载 —— 重挂载得到的是「关着」的初始态，看到的是收起
 * 而不是展开。所以它走状态机：先收起，等收起那一段真的走完再展开，于是每次都从
 * 「全收起」出发、能看见「展开」这一下。收起方向用的是同一个 transition（同一时长），
 * 所以等待时间必须跟着 duration 走 —— 只等一个固定短值会在半收状态就反向，几列的
 * 起点就不一致了，比较也就不公平。
 */
function ExpandStage({ curve, duration, run }: { curve: MotionCurve; duration: number; run: number }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (run === 0) return;
    setOpen(false);
    const timer = setTimeout(() => setOpen(true), duration + 60);
    return () => clearTimeout(timer);
  }, [run, duration]);

  return (
    <>
      <div className={`mo-expand${open ? ' is-open' : ''}`} style={motionStyle(curve, duration)}>
        <div className="mo-expand__inner">
          <div className="mo-expand__body">
            <span>面板内容按自己的高度展开。</span>
            <span>外壳是 grid 容器，不必预先知道有多高。</span>
          </div>
        </div>
      </div>
      <button type="button" className="btn btn-sm btn-secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? '收起面板' : '展开面板'}
      </button>
    </>
  );
}

/** 分段滑块：点选项切换，只有滑块那一条 transform 在动。`run` 变化时前进一格，供「一起重播」用。 */
function SegmentStage({ curve, duration, run }: { curve: MotionCurve; duration: number; run: number }) {
  const [index, setIndex] = useState(0);
  const thumbStyle = { ...motionStyle(curve, duration), '--mo-i': index } as CSSProperties;

  useEffect(() => {
    if (run === 0) return;
    setIndex((value) => (value + 1) % 4);
  }, [run]);

  return (
    <div className="mo-slider">
      <span className="mo-slider__thumb" style={thumbStyle} aria-hidden="true" />
      {['一', '二', '三', '四'].map((label, position) => (
        <button
          key={label}
          type="button"
          className={`mo-slider__opt${position === index ? ' is-active' : ''}`}
          aria-pressed={position === index}
          onClick={() => setIndex(position)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * 数字递增：中间值由 JS 按同一条曲线算，与 CSS 那边同源。
 * `run` 进依赖数组 —— 重播时先把值清回 0 再跑一遍。
 */
function CounterStage({
  curve,
  duration,
  reduce,
  run,
}: {
  curve: MotionCurve;
  duration: number;
  reduce: boolean;
  run: number;
}) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    // 减少动态效果时不演中间过程、直接落在终值上 —— 与样式表关掉动画是同一口径。
    if (reduce) {
      setValue(1000);
      return;
    }
    setValue(0);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // 不裁剪：过冲曲线中途会超过 1000，那正是这一列要让人看见的东西。
      setValue(Math.round(sampleEasing(curve.points, progress) * 1000));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else setValue(1000);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [curve, duration, reduce, run]);

  return (
    <div className="mo-counter">
      <output className="numeric">{value}</output>
      <span className="mo-counter__cap">0 → 1000</span>
    </div>
  );
}

/** 舞台本体。`run` 参与 key：重播时整块重挂载，CSS 动画从第一帧重来。 */
function VariantStage({
  kind,
  variant,
  curve,
  reduce,
  run,
}: {
  kind: ScenarioKind;
  variant: MotionVariant;
  curve: MotionCurve;
  reduce: boolean;
  run: number;
}) {
  const style = motionStyle(curve, variant.duration);
  const scene = kind;

  // 展开那格的「重播」= 先收起再展开一次，由 ExpandStage 自己接管状态。
  // 短尾三格复用同样的舞台结构，只是换了曲线（尾端控制点不同）。
  if (scene === 'expand' || scene === 'expand-tail') {
    return <ExpandStage curve={curve} duration={variant.duration} run={run} />;
  }
  if (scene === 'segment' || scene === 'segment-tail') {
    return <SegmentStage curve={curve} duration={variant.duration} run={run} />;
  }
  if (scene === 'dropdown') {
    return <TailDropdown curve={curve} duration={variant.duration} run={run} />;
  }
  if (scene === 'counter') {
    return <CounterStage curve={curve} duration={variant.duration} reduce={reduce} run={run} />;
  }

  if (scene === 'entrance') {
    return (
      <div className="mo-rise" style={style} key={run}>
        <span className="mo-rise__dot" aria-hidden="true" />
        <span className="mo-rise__text">从下方 12px 处就位</span>
      </div>
    );
  }

  if (scene === 'stagger') {
    const gap = variant.stagger ?? 0;
    return (
      <div className="mo-stagger" key={run}>
        {[0, 1, 2, 3, 4].map((item) => (
          <div
            key={item}
            className="mo-stagger__item"
            style={{ ...style, '--mo-delay': `${item * gap}ms` } as CSSProperties}
          >
            第 {item + 1} 项
          </div>
        ))}
      </div>
    );
  }

  if (scene === 'overlay') {
    return (
      <div className="mo-stage--overlay" key={run}>
        <span className="mo-overlay__scrim" style={style} aria-hidden="true" />
        <span className="mo-overlay__panel" style={style}>弹层内容</span>
      </div>
    );
  }

  if (scene === 'hover') {
    return (
      <div className="mo-hover" style={style} tabIndex={0}>
        把鼠标移上来
      </div>
    );
  }

  if (scene === 'progress') {
    return (
      <>
        <div className="mo-bar">
          <div className="mo-bar__fill" style={style} key={run} />
        </div>
        <span className="mo-bar__cap">{curve.name}</span>
      </>
    );
  }

  return (
    <div className="mo-fade" style={style} key={run}>
      内容已替换
    </div>
  );
}

// ── 变体卡 ───────────────────────────────────────────────────────────────────

function VariantCard({
  scenario,
  variant,
  reduce,
  batch,
}: {
  scenario: MotionScenario;
  variant: MotionVariant;
  reduce: boolean;
  batch: number;
}) {
  const curve = curveById(variant.curveId);
  const spark = useMemo(() => {
    // 尾巴长度那三格按**实际时间**画：曲线只画到自己时长，留出右侧空白 —— 一眼能看出
    // 这档比现版早停多久。其余场景仍画归一化后的曲线形状（每列时长本来就不一样）。
    const inTailGroup = TAIL_SCENARIO_IDS.has(scenario.id);
    const scale = inTailGroup ? variant.duration / INTERACTION_DURATION : 1;
    const points = sampleEasingPoints(curve.points, 32).map(([x, y]): [number, number] => [x * scale, y]);
    return toPath(points, SPARK_HEIGHT);
  }, [curve, scenario.id, variant.duration]);
  // 两张「重播」共用同一个计数：本卡的单列重播 + 场景级「一起重播」。
  const [run, setRun] = useState(0);
  const replayToken = run + batch;

  // 读数只写曲线与时长：stagger 的间隔已经印在标签里，再写一遍是噪音。
  const readout = `${curveCss(curve)} · ${variant.duration}ms`;
  const sparkClass = [
    'mo-spark__line',
    curve.verdict === 'avoid' ? 'mo-spark__line--risky' : curve.verdict === 'candidate' ? 'mo-spark__line--plain' : null,
  ].filter(Boolean).join(' ');

  // 悬停与滑块不能靠重播看：一个要真鼠标、一个要自己点选项；下拉面板有自动展开的状态机。
  const replayable = scenario.id !== 'hover' && scenario.id !== 'segment' && scenario.id !== 'segment-tail';

  // 统一的取值要一眼能找到 —— 每场景都有一列是它，靠序号猜不合适。
  // 读数据里那个显式标记，别按「曲线 + 时长」推：逐条入场那格有两列都是 540ms。
  const adopted = variant.adopted === true;

  return (
    <article className={adopted ? 'mo-variant mo-variant--adopted' : 'mo-variant'}>
      <div className="mo-variant__head">
        <span className="mo-variant__label">
          {adopted && <span className="mo-variant__flag">统一取值</span>}
          {variant.label}
        </span>
        <span className="mo-variant__readout numeric">{readout}</span>
      </div>
      <svg className="mo-variant__spark" viewBox={`0 0 ${PLOT_SIZE} ${SPARK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <rect className="mo-spark__frame" x="0.4" y="0.4" width="99.2" height="35.2" rx="2" />
        <path className={sparkClass} d={spark} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={`mo-variant__stage mo-variant__stage--${scenario.id}`}>
        <VariantStage kind={scenario.id} variant={variant} curve={curve} reduce={reduce} run={replayToken} />
      </div>
      {replayable && (
        <div className="mo-variant__controls">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setRun((value) => value + 1)}>
            重播
          </button>
        </div>
      )}
    </article>
  );
}

// ── 场景 ─────────────────────────────────────────────────────────────────────

/** 尾巴长度那一组才配「一起重播」—— 它们本来就是让人同时看五列差别的。 */
const TAIL_SCENARIO_IDS = new Set(TAIL_SCENARIOS.map((scenario) => scenario.id));

function ScenarioBlock({ scenario, reduce }: { scenario: MotionScenario; reduce: boolean }) {
  const [batch, setBatch] = useState(0);
  return (
    <section className="mo-scenario" aria-labelledby={`mo-${scenario.id}`}>
      <div className="mo-scenario__head">
        <h2 className="mo-scenario__title" id={`mo-${scenario.id}`}>{scenario.title}</h2>
        <span className="mo-scenario__meta">{scenario.meta}</span>
        {TAIL_SCENARIO_IDS.has(scenario.id) && (
          <button type="button" className="btn btn-sm btn-secondary mo-scenario__replay" onClick={() => setBatch((value) => value + 1)}>
            一起重播
          </button>
        )}
      </div>
      <p className="mo-scenario__hint">{scenario.hint}</p>
      <div className="mo-variants">
        {scenario.variants.map((variant) => (
          <VariantCard key={variant.key} scenario={scenario} variant={variant} reduce={reduce} batch={batch} />
        ))}
      </div>
    </section>
  );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export default function MotionLab() {
  const reduce = useReducedMotion();
  const [picked, setPicked] = useState<string | null>(null);
  // 换 epoch 重挂载整列场景 = 一次「全部重播」。
  const [epoch, setEpoch] = useState(0);

  return (
    <div className="container mo-lab">
      <header className="mo-lab__header">
        <Link className="game-back" href="/game/collections/test">返回测试合集</Link>
        <h1>动效试验台</h1>
        <p className="mo-lab__notice" role="note">
          <strong>本页仅作展示，不作定稿。</strong>
          这里的曲线、时长与组件都是比较用的样张；标着「已采用 / 统一取值」的条目也只是试验台里的结论标记，
          不代表全站已经定稿 —— 真正落地的取值以 <code>curves.ts</code> 与规范文档为准。
        </p>
        <p className="mo-lab__lead">
          同一个场景、同一段动画，每列只换速度曲线和时长。已定：交互产生的反馈动画统一走
          「交互动画」（<span className="numeric">{curveCss(curveById(INTERACTION_CURVE_ID))}</span>，
          默认 {INTERACTION_DURATION}ms），所以每个场景的第一列就是它。其余列留着对照 ——
          用来发现哪些场景其实不该跟这条统一取值。
        </p>
        <div className="mo-lab__toolbar">
          <button type="button" className="btn btn-secondary" onClick={() => setEpoch((value) => value + 1)}>
            全部重播
          </button>
          <span className="mo-lab__toolbar-label">
            {reduce
              ? '系统已开启「减少动态效果」：动画不播放，元素直接呈现在终态。'
              : '每列只比曲线与时长，其余结构一致。悬停与滑块两格要自己操作。'}
          </span>
        </div>
      </header>

      <CurveOverview picked={picked} onPick={setPicked} />

      <TailFamilySection />

      <div key={epoch}>
        {TAIL_SCENARIOS.map((scenario) => (
          <ScenarioBlock key={scenario.id} scenario={scenario} reduce={reduce} />
        ))}
        {MOTION_SCENARIOS.map((scenario) => (
          <ScenarioBlock key={scenario.id} scenario={scenario} reduce={reduce} />
        ))}
      </div>
    </div>
  );
}
