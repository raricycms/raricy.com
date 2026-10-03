'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickSample, ClickVerdict } from '@/lib/captcha-demo/click-trace';

// ─────────────────────────────────────────────────────────────────────────────
// ClickDemo.tsx — 点选验证码演示（**尚未接进签到**，独立跑在 /captcha-demo/click）。
//
// 【为什么这里没有「模拟脚本」按钮】滑块页有，这页没有，是刻意的：
//   合成一条机器人轨迹需要**知道答案坐标**（机器人正是要点在那几个字上）。
//   要在这个页面上做，就得把答案下发到浏览器 —— 那就等于在页面上开一个泄漏口，
//   而这页的整个卖点就是「答案不下发」。攻击模拟改由独立程序离线跑，见 tests/attack/。
//
// 【采样只记不拦】本地不做任何判定 —— 客户端算出来的结论攻击者伸手就能改。
//   这里只负责把 (t, x, y) 与点击序列如实记下来交给服务端。
// ─────────────────────────────────────────────────────────────────────────────

interface ChallengeDto {
  id: string;
  image: string;
  promptChars: string[];
  width: number;
  height: number;
  radius: number;
}

interface ClickResultDto {
  ok: boolean;
  dx: number;
  dy: number;
  dist: number;
}

interface VerifyDto {
  passed: boolean;
  positionOk: boolean;
  clickResults: ClickResultDto[];
  verdict: ClickVerdict | null;
  behaviorBlocks?: boolean;
  blockedByBehavior?: boolean;
  clusterSize: number;
  targets?: { x: number; y: number }[];
  radius?: number;
  traceError?: string;
}

type Phase = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

const BAND_LABEL: Record<string, string> = {
  human: '像人',
  suspect: '可疑',
  bot: '像脚本',
};

const SIGNAL_ROWS: {
  key: keyof ClickVerdict['signals'];
  label: string;
  fmt: (v: number) => string;
}[] = [
  { key: 'clickCount', label: '点击次数', fmt: (v) => String(v) },
  { key: 'moveCount', label: '移动采样总数', fmt: (v) => String(v) },
  { key: 'movesPerSegment', label: '每段移动采样数', fmt: (v) => v.toFixed(1) },
  { key: 'firstClickDelayMs', label: '起手延迟', fmt: (v) => `${Math.round(v)} ms` },
  { key: 'totalMs', label: '点完全程', fmt: (v) => `${Math.round(v)} ms` },
  { key: 'interClickCv', label: '点击间隔变异系数', fmt: (v) => v.toFixed(3) },
  { key: 'moveDtCv', label: '移动采样变异系数', fmt: (v) => v.toFixed(3) },
  { key: 'pathStraightness', label: '路径直线度', fmt: (v) => v.toFixed(4) },
  { key: 'meanCenterOffsetPx', label: '平均偏心（距字心）', fmt: (v) => `${v.toFixed(2)} px` },
];

export default function ClickDemo() {
  const [challenge, setChallenge] = useState<ChallengeDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [marks, setMarks] = useState<{ x: number; y: number }[]>([]);
  const [result, setResult] = useState<VerifyDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const t0Ref = useRef(0);
  const movesRef = useRef<ClickSample[]>([]);
  const clicksRef = useRef<ClickSample[]>([]);
  const trustedRef = useRef(true);
  const pointerTypeRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const loadChallenge = useCallback(async () => {
    setPhase('loading');
    setResult(null);
    setError(null);
    setMarks([]);
    movesRef.current = [];
    clicksRef.current = [];
    busyRef.current = false;
    try {
      const res = await fetch('/api/captcha-demo/click/challenge', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? '出题失败');
      setChallenge(data as ChallengeDto);
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

  /** 把浏览器坐标换算回图片的自然坐标系（图片可能被 CSS 缩放过）。 */
  function toImageCoords(e: React.PointerEvent<HTMLDivElement>, ch: ChallengeDto) {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ch.width / rect.width;
    const sy = ch.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  async function submit(id: string) {
    busyRef.current = true;
    setPhase('submitting');
    try {
      const res = await fetch('/api/captcha-demo/click/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          trace: {
            moves: movesRef.current,
            clicks: clicksRef.current,
            meta: { pointerType: pointerTypeRef.current, allTrusted: trustedRef.current },
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? '判定失败');
      setResult(data as VerifyDto);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '判定失败');
      setPhase('error');
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!challenge || phase !== 'ready') return;
    if (!e.isTrusted) trustedRef.current = false;
    const p = toImageCoords(e, challenge);
    movesRef.current.push({ t: performance.now() - t0Ref.current, x: p.x, y: p.y });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!challenge || phase !== 'ready' || busyRef.current) return;
    if (!e.isTrusted) trustedRef.current = false;
    pointerTypeRef.current = e.pointerType || null;

    const p = toImageCoords(e, challenge);
    clicksRef.current.push({ t: performance.now() - t0Ref.current, x: p.x, y: p.y });
    setMarks((m) => [...m, p]);

    // 点满了就自动交卷 —— 题目要求的就是「依次点 N 下」，多点无益
    if (clicksRef.current.length >= challenge.promptChars.length) {
      void submit(challenge.id);
    }
  }

  const need = challenge?.promptChars.length ?? 0;
  const v = result?.verdict ?? null;

  return (
    <div className="cdm">
      <header className="cdm__head">
        <nav className="cdm__nav">
          <a href="/captcha-demo">滑块</a>
          <span className="cdm__nav-current">点选</span>
          <a href="/captcha-demo/vision">视觉任务</a>
        </nav>
        <h1 className="cdm__title">点选人机验证 · 演示</h1>
        <p className="cdm__sub">
          按顺序点中下面这几个字。<strong>答案即点击坐标本身</strong> ——
          与滑块不同，录一条旧轨迹换一题就对不上。
        </p>
      </header>

      <div className="cdm__prompt">
        <span className="cdm__prompt-label">依次点击</span>
        {challenge?.promptChars.map((c, i) => (
          <span key={`${c}-${i}`} className="cdm__prompt-char">
            {c}
          </span>
        ))}
        <span className="cdm__prompt-progress">
          {marks.length} / {need}
        </span>
      </div>

      <div
        className="cdm__stage cdm__stage--click"
        style={{ aspectRatio: `${challenge?.width ?? 340} / ${challenge?.height ?? 180}` }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
      >
        {challenge ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cdm__bg" src={challenge.image} alt="" draggable={false} />
            {marks.map((m, i) => (
              <span
                key={i}
                className="cdm__mark"
                style={{
                  left: `${(m.x / challenge.width) * 100}%`,
                  top: `${(m.y / challenge.height) * 100}%`,
                }}
              >
                {i + 1}
              </span>
            ))}
            {result?.targets?.map((t, i) => (
              <span
                key={`t${i}`}
                className={`cdm__target${result.clickResults[i]?.ok ? ' cdm__target--ok' : ''}`}
                style={{
                  left: `${(t.x / challenge.width) * 100}%`,
                  top: `${(t.y / challenge.height) * 100}%`,
                  width: `${((result.radius ?? 24) * 2 * 100) / challenge.width}%`,
                  aspectRatio: '1',
                }}
              />
            ))}
          </>
        ) : (
          <div className="cdm__placeholder">{phase === 'error' ? '出题失败' : '正在出题…'}</div>
        )}
      </div>

      <div className="cdm__actions">
        <button
          type="button"
          className="cdm__btn"
          onClick={() => void loadChallenge()}
          disabled={phase === 'loading' || phase === 'submitting'}
        >
          重新出题
        </button>
      </div>

      {error && <p className="cdm__error">{error}</p>}

      {result && (
        <section className={`cdm__result cdm__result--${v ? v.band : 'bot'}`}>
          <div className="cdm__verdict">
            <span className="cdm__verdict-pass">{result.passed ? '通过' : '未通过'}</span>
            {v && (
              <span className={`cdm__band cdm__band--${v.band}`}>
                {BAND_LABEL[v.band]} · {v.score} 分
              </span>
            )}
          </div>

          {result.traceError ? (
            <p className="cdm__line cdm__line--bad">{result.traceError}</p>
          ) : (
            <p className="cdm__line">
              位置：
              {result.clickResults
                .map((r, i) => `#${i + 1} ${r.ok ? '✓' : `✗(${r.dist}px)`}`)
                .join('  ')}
            </p>
          )}

          {result.blockedByBehavior && result.behaviorBlocks === false && (
            <p className="cdm__line cdm__line--warn">
              行为判为 bot —— 但按现行策略<strong>不拦截</strong>（只记录）。
            </p>
          )}

          {v && (
            <>
              <p className="cdm__line">
                行为：{result.clusterSize > 1
                  ? `这条轨迹的指纹已出现 ${result.clusterSize} 次 —— 有别的会话拖着几乎一样的轨迹`
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
            </>
          )}
        </section>
      )}
    </div>
  );
}
