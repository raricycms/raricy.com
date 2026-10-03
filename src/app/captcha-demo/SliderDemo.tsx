'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraceInput, TraceSample, TraceVerdict } from '@/lib/captcha-demo/trace';
import { buildSyntheticTrace, type SyntheticMode } from './synthetic';

// ─────────────────────────────────────────────────────────────────────────────
// SliderDemo.tsx — 滑块验证码演示（**尚未接进签到**，独立跑在 /captcha-demo）。
//
// 【它演示的是两件事，缺一不可】
//   1. 位置：拼图块拖到缺口上（服务端比容差，答案从不下发）
//   2. 行为：整段拖动被采样，服务端照 trace.ts 判「像人还是像脚本」
//   位置那条能被图像匹配算出来，**行为才是真正拦脚本的那道门**。
//
// 【采样只记不拦】本地不做任何判定 —— 客户端算出来的结论攻击者伸手就能改。
//   这里只负责把 (t, x, y) 如实记下来交给服务端。
// ─────────────────────────────────────────────────────────────────────────────

interface ChallengeDto {
  id: string;
  background: string;
  piece: string;
  pieceY: number;
  pieceSize: number;
  width: number;
  height: number;
  maxOffset: number;
}

interface VerifyDto {
  passed: boolean;
  positionOk: boolean;
  dx: number;
  tolerance: number;
  verdict: TraceVerdict | null;
  /** 轨迹终点与提交的 x 是否自洽。false = 这份轨迹是从别处录来重放的。 */
  trajectoryConsistent?: boolean;
  /** 行为判定当前是否参与拦截（服务端常量，默认 false）。 */
  behaviorBlocks?: boolean;
  /** 这一次是否会被行为判定拦下 —— 拦截关着时它只是观察值。 */
  blockedByBehavior?: boolean;
  clusterSize: number;
  answerX?: number;
  traceError?: string;
}

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const BAND_LABEL: Record<string, string> = {
  human: '像人',
  suspect: '可疑',
  bot: '像脚本',
};

/** 信号表的展示顺序与中文名。数值格式化不碰 toLocale*（见 db-time-guard 规则 4）。 */
const SIGNAL_ROWS: { key: keyof TraceVerdict['signals']; label: string; fmt: (v: number) => string }[] = [
  { key: 'sampleCount', label: '采样点数', fmt: (v) => String(v) },
  { key: 'durationMs', label: '拖动总时长', fmt: (v) => `${Math.round(v)} ms` },
  { key: 'startDelayMs', label: '起手延迟', fmt: (v) => `${Math.round(v)} ms` },
  { key: 'settleMs', label: '落点到松手', fmt: (v) => `${Math.round(v)} ms` },
  { key: 'dtCv', label: '采样间隔变异系数', fmt: (v) => v.toFixed(3) },
  { key: 'linearR2', label: '轨迹线性度 R²', fmt: (v) => v.toFixed(5) },
  { key: 'reversals', label: '方向反转次数', fmt: (v) => String(v) },
  { key: 'maxVelocity', label: '最大速度', fmt: (v) => `${v.toFixed(2)} px/ms` },
  // 只展示不判定：真人快推时它同样会很大（度量的是采样节奏，不是人手）——
  // 见 trace.ts「关于『瞬移步』为什么不在下面」
  { key: 'stepSpikeRatio', label: '瞬移比（仅观察，不参与判定）', fmt: (v) => v.toFixed(1) },
  { key: 'yStdDev', label: '纵坐标抖动 σ', fmt: (v) => v.toFixed(4) },
  { key: 'pauseRatio', label: '停顿占比', fmt: (v) => v.toFixed(3) },
];

export default function SliderDemo() {
  const [challenge, setChallenge] = useState<ChallengeDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<VerifyDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const t0Ref = useRef(0);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const samplesRef = useRef<TraceSample[]>([]);
  const trustedRef = useRef(true);
  const pointerTypeRef = useRef<string | null>(null);

  const loadChallenge = useCallback(async () => {
    setPhase('loading');
    setResult(null);
    setError(null);
    offsetRef.current = 0;
    setOffset(0);
    try {
      const res = await fetch('/api/captcha-demo/challenge', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? '出题失败');
      setChallenge(data as ChallengeDto);
      // t0 = 挑战渲染完成的时刻，之后所有采样都以它为原点
      t0Ref.current = performance.now();
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '出题失败');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void loadChallenge();
  }, [loadChallenge]);

  // id 走参数而不是闭包读 state —— 不然 useCallback 的依赖里得挂上 challenge，
  // 每次拖动都会重建这个回调
  const submit = useCallback(async (id: string, x: number, trace: TraceInput) => {
    setPhase('submitting');
    try {
      const res = await fetch('/api/captcha-demo/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, x, trace }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? '判定失败');
      setResult(data as VerifyDto);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '判定失败');
      setPhase('error');
    }
  }, []);

  function pushSample(y: number, x: number) {
    samplesRef.current.push({ t: performance.now() - t0Ref.current, x, y });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!challenge || phase !== 'ready') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startOffsetRef.current = offsetRef.current;
    samplesRef.current = [];
    trustedRef.current = e.isTrusted;
    pointerTypeRef.current = e.pointerType || null;
    pushSample(e.clientY, offsetRef.current);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !challenge) return;
    if (!e.isTrusted) trustedRef.current = false;
    const next = clamp(
      startOffsetRef.current + (e.clientX - startXRef.current),
      0,
      challenge.maxOffset
    );
    offsetRef.current = next;
    setOffset(next);
    pushSample(e.clientY, next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !challenge) return;
    draggingRef.current = false;
    if (!e.isTrusted) trustedRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已经没了（比如指针被取消）—— 不值得因此中断提交流程
    }
    const endMs = performance.now() - t0Ref.current;
    void submit(challenge.id, offsetRef.current, {
      samples: samplesRef.current,
      meta: {
        pointerType: pointerTypeRef.current,
        allTrusted: trustedRef.current,
        endMs,
      },
    });
  }

  /** 合成一条机器人轨迹直接提交 —— 见 synthetic.ts 的说明。 */
  function runSynthetic(mode: SyntheticMode) {
    if (!challenge || phase === 'submitting') return;
    const run = buildSyntheticTrace(mode, challenge.maxOffset);
    offsetRef.current = run.finalOffset;
    setOffset(run.finalOffset);
    void submit(challenge.id, run.finalOffset, { samples: run.samples, meta: run.meta });
  }

  const v = result?.verdict ?? null;

  return (
    <div className="cdm">
      <header className="cdm__head">
        <nav className="cdm__nav">
          <span className="cdm__nav-current">滑块</span>
          <a href="/captcha-demo/click">点选</a>
          <a href="/captcha-demo/vision">视觉任务</a>
        </nav>
        <h1 className="cdm__title">滑块人机验证 · 演示</h1>
        <p className="cdm__sub">
          拖动拼图块补上缺口。<strong>位置</strong>与<strong>行为</strong>是两道独立的门 ——
          位置对了但轨迹判成脚本，一样不通过。
        </p>
      </header>

      <div className="cdm__stage" style={{ width: challenge?.width ?? 340 }}>
        {challenge ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cdm__bg" src={challenge.background} alt="" width={challenge.width} height={challenge.height} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="cdm__piece"
              src={challenge.piece}
              alt=""
              width={challenge.pieceSize}
              height={challenge.pieceSize}
              style={{ left: offset, top: challenge.pieceY }}
            />
          </>
        ) : (
          <div className="cdm__placeholder">{phase === 'error' ? '出题失败' : '正在出题…'}</div>
        )}
      </div>

      <div className="cdm__rail" style={{ width: challenge?.maxOffset ?? 276 }}>
        <div className="cdm__rail-fill" style={{ width: offset }} />
        <div
          className={`cdm__handle${phase === 'ready' ? '' : ' cdm__handle--locked'}`}
          style={{ left: offset }}
          role="slider"
          aria-label="拖动滑块"
          aria-valuemin={0}
          aria-valuemax={challenge?.maxOffset ?? 0}
          aria-valuenow={offset}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="cdm__handle-arrow">{'→'}</span>
        </div>
      </div>

      <div className="cdm__actions">
        <button type="button" className="cdm__btn" onClick={() => void loadChallenge()} disabled={phase === 'loading' || phase === 'submitting'}>
          重新出题
        </button>
        <button type="button" className="cdm__btn cdm__btn--ghost" onClick={() => runSynthetic('naive')} disabled={!challenge || phase === 'submitting'}>
          模拟脚本 · 匀速直线
        </button>
        <button type="button" className="cdm__btn cdm__btn--ghost" onClick={() => runSynthetic('smart')} disabled={!challenge || phase === 'submitting'}>
          模拟脚本 · 缓动抖回抽
        </button>
      </div>

      {error && <p className="cdm__error">{error}</p>}

      {result && v && (
        <section className={`cdm__result cdm__result--${v.band}`}>
          <div className="cdm__verdict">
            <span className="cdm__verdict-pass">{result.passed ? '通过' : '未通过'}</span>
            <span className={`cdm__band cdm__band--${v.band}`}>
              {BAND_LABEL[v.band]} · {v.score} 分
            </span>
          </div>

          <p className="cdm__line">
            位置：{result.positionOk ? '命中' : '未命中'}（偏差 {result.dx}px，容差 {result.tolerance}px
            {result.answerX !== undefined ? `，答案 x=${result.answerX}` : ''}）
          </p>
          {result.trajectoryConsistent === false && (
            <p className="cdm__line cdm__line--bad">
              轨迹终点与落点对不上 —— 这份轨迹是从别的挑战录来重放的
            </p>
          )}
          {result.blockedByBehavior && result.behaviorBlocks === false && (
            <p className="cdm__line cdm__line--warn">
              行为判为 bot —— 但按现行策略<strong>不拦截</strong>（只记录）。理由与翻牌开关见
              verify/route.ts 的 BEHAVIOR_BLOCKS。
            </p>
          )}
          <p className="cdm__line">
            行为：{result.clusterSize > 1
              ? `这条轨迹的指纹已经出现过 ${result.clusterSize} 次 —— 有别的会话拖着一条几乎一样的轨迹`
              : '这条轨迹的指纹是首次出现'}
          </p>

          {v.flags.length > 0 ? (
            <ul className="cdm__flags">
              {v.flags.map((f) => (
                <li key={f.key} className="cdm__flag">
                  <span className="cdm__flag-w">−{f.weight}</span>
                  <span className="cdm__flag-label">{f.label}</span>
                  <span className="cdm__flag-detail">{f.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cdm__line cdm__line--ok">没命中任何可疑特征。</p>
          )}

          <details className="cdm__signals">
            <summary>原始信号</summary>
            <dl>
              {SIGNAL_ROWS.map((row) => (
                <div key={row.key} className="cdm__signal">
                  <dt>{row.label}</dt>
                  <dd>{row.fmt(v.signals[row.key])}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>
      )}

      {result && !v && (
        <section className="cdm__result cdm__result--bot">
          <p className="cdm__line">轨迹被拒：{result.traceError}</p>
          <p className="cdm__line">位置判定：{result.positionOk ? '命中' : '未命中'}（偏差 {result.dx}px）</p>
        </section>
      )}
    </div>
  );
}
