'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// VisionDemo.tsx — 「视觉空间任务」演示（**尚未接进签到**，跑在 /captcha-demo/vision）。
//
// 【这一页刻意没有「模拟脚本」按钮】同点选页：合成一条机器人作答需要知道答案坐标，
//   放到页面上等于开一个泄漏口。攻击模拟由 scripts/captcha-attack/ 下的独立程序跑。
//
// 【客户端不算任何判定】它只做三件事：显示当前阶段的图与指令、把点击/拖拽的坐标
//   如实交上去、把服务端的裁定渲染成反馈。所有取舍都在服务端。
// ─────────────────────────────────────────────────────────────────────────────

interface StageDto {
  sessionId: string;
  index: number;
  total: number;
  form: 'simple' | 'relative' | 'drag';
  prompt: string;
  image: string;
  width: number;
  height: number;
}

interface StepDto {
  stagePassed: boolean;
  done: boolean;
  passed?: boolean;
  total?: number;
  failedAt?: number;
  youHit?: string;
  wantHint?: string;
  next?: StageDto;
}

type Phase = 'loading' | 'playing' | 'checking' | 'stageOk' | 'failed' | 'passed' | 'error';

const FORM_LABEL: Record<StageDto['form'], string> = {
  simple: '找图形',
  relative: '找方位',
  drag: '拖拽',
};

const FORM_HINT: Record<StageDto['form'], string> = {
  simple: '点中指令描述的那个图形',
  relative: '先找到参照物，再在它的一侧找目标',
  drag: '按住要拖的图形，拖到目标图形上松手',
};

export default function VisionDemo() {
  const [stage, setStage] = useState<StageDto | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'bad'; x: number; y: number } | null>(null);
  const [failed, setFailed] = useState<{ youHit: string; wantHint: string; failedAt: number; total: number } | null>(null);
  const [cleared, setCleared] = useState(0);
  const [press, setPress] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const stageRef = useRef<StageDto | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const busyRef = useRef(false);

  const start = useCallback(async () => {
    setPhase('loading');
    setError(null);
    setFailed(null);
    setFeedback(null);
    setCleared(0);
    setPress(null);
    setCursor(null);
    pressRef.current = null;
    busyRef.current = false;
    try {
      const res = await fetch('/api/captcha-demo/vision/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? '出题失败');
      stageRef.current = data as StageDto;
      setStage(data as StageDto);
      setPhase('playing');
    } catch (e) {
      setError(e instanceof Error ? e.message : '出题失败');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  /** 浏览器坐标 → 图片自然坐标（图片可能被 CSS 缩放过）。 */
  function toImage(e: React.PointerEvent<HTMLDivElement>, s: StageDto) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (s.width / rect.width),
      y: (e.clientY - rect.top) * (s.height / rect.height),
    };
  }

  async function submit(s: StageDto, point: { x: number; y: number }, from: { x: number; y: number } | null) {
    busyRef.current = true;
    setPhase('checking');
    try {
      const res = await fetch('/api/captcha-demo/vision/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: s.sessionId,
          index: s.index,
          x: point.x,
          y: point.y,
          ...(from ? { from } : {}),
        }),
      });
      const data = (await res.json()) as StepDto & { message?: string };
      if (!res.ok) throw new Error(data?.message ?? '判定失败');

      if (data.passed) {
        setFeedback({ kind: 'ok', x: point.x, y: point.y });
        setCleared(s.total);
        setPhase('passed');
        return;
      }
      if (!data.stagePassed) {
        setFeedback({ kind: 'bad', x: point.x, y: point.y });
        setFailed({
          youHit: data.youHit ?? '（未知）',
          wantHint: data.wantHint ?? '',
          failedAt: data.failedAt ?? s.index,
          total: data.total ?? s.total,
        });
        setPhase('failed');
        return;
      }
      // 本阶段过了，进入下一阶段
      setFeedback({ kind: 'ok', x: point.x, y: point.y });
      setCleared(s.index + 1);
      setPhase('stageOk');
      const next = data.next!;
      setTimeout(() => {
        stageRef.current = next;
        setStage(next);
        setFeedback(null);
        setCleared(next.index);
        busyRef.current = false;
        setPhase('playing');
      }, 720);
    } catch (e) {
      setError(e instanceof Error ? e.message : '判定失败');
      setPhase('error');
      busyRef.current = false;
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const s = stageRef.current;
    if (!s || phase !== 'playing' || busyRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e, s);
    pressRef.current = p;
    setPress(p);
    setCursor(p);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = stageRef.current;
    if (!s || !pressRef.current) return;
    setCursor(toImage(e, s));
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const s = stageRef.current;
    const down = pressRef.current;
    if (!s || !down || phase !== 'playing' || busyRef.current) return;
    pressRef.current = null;
    setPress(null);
    setCursor(null);
    const up = toImage(e, s);

    if (s.form === 'drag') {
      // 原地一点不算拖 —— 否则「按住松手」就能蒙混过去
      if (Math.hypot(up.x - down.x, up.y - down.y) < 12) return;
      void submit(s, up, down);
    } else {
      void submit(s, down, null);
    }
  }

  const dots = stage ? Array.from({ length: stage.total }, (_, i) => i) : [];

  return (
    <div className="cdm">
      <header className="cdm__head">
        <nav className="cdm__nav">
          <a href="/captcha-demo">滑块</a>
          <a href="/captcha-demo/click">点选</a>
          <span className="cdm__nav-current">视觉任务</span>
        </nav>
        <h1 className="cdm__title">视觉空间任务 · 演示</h1>
        <p className="cdm__sub">
          读懂指令，找出它说的那个图形。<strong>三关连着过</strong>，错一关就要从头来。
        </p>
      </header>

      {stage && (
        <div className="vdm__bar">
          <div className="vdm__dots">
            {dots.map((i) => (
              <span
                key={i}
                className={
                  'vdm__dot' +
                  (i < cleared ? ' vdm__dot--done' : i === stage.index ? ' vdm__dot--now' : '')
                }
              >
                {i < cleared ? '✓' : i + 1}
              </span>
            ))}
          </div>
          <span className="vdm__stage-label">
            第 {stage.index + 1}/{stage.total} 关 · {FORM_LABEL[stage.form]}
          </span>
        </div>
      )}

      <div className={`vdm__scene-wrap${feedback?.kind === 'bad' ? ' vdm__scene-wrap--shake' : ''}`}>
        <div
          className={`vdm__scene${stage?.form === 'drag' ? ' vdm__scene--drag' : ''}`}
          style={{ aspectRatio: `${stage?.width ?? 400} / ${stage?.height ?? 230}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {stage ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="cdm__bg" src={stage.image} alt="" draggable={false} />
              {press && cursor && stage.form === 'drag' && (
                <svg className="vdm__trail" viewBox={`0 0 ${stage.width} ${stage.height}`}>
                  <line x1={press.x} y1={press.y} x2={cursor.x} y2={cursor.y} />
                  <circle cx={press.x} cy={press.y} r="6" />
                  <circle cx={cursor.x} cy={cursor.y} r="6" />
                </svg>
              )}
              {feedback && (
                <span
                  className={`vdm__mark vdm__mark--${feedback.kind}`}
                  style={{
                    left: `${(feedback.x / (stage.width || 1)) * 100}%`,
                    top: `${(feedback.y / (stage.height || 1)) * 100}%`,
                  }}
                >
                  {feedback.kind === 'ok' ? '✓' : '✕'}
                </span>
              )}
            </>
          ) : (
            <div className="cdm__placeholder">{phase === 'error' ? '出题失败' : '正在准备…'}</div>
          )}
        </div>
      </div>

      {stage && phase !== 'passed' && (
        <div className="vdm__prompt">
          <span className="vdm__prompt-icon">{stage.form === 'drag' ? '✋' : '👆'}</span>
          <span className="vdm__prompt-text">{stage.prompt}</span>
        </div>
      )}

      {stage && phase === 'playing' && (
        <p className="vdm__hint">{FORM_HINT[stage.form]}</p>
      )}
      {phase === 'checking' && <p className="vdm__hint">判定中…</p>}
      {phase === 'stageOk' && <p className="vdm__hint vdm__hint--ok">对！进入下一关…</p>}

      {phase === 'failed' && failed && (
        <section className="vdm__result vdm__result--bad">
          <h2 className="vdm__result-title">第 {failed.failedAt + 1} 关没过</h2>
          <p className="vdm__result-line">
            你碰到的是<strong>{failed.youHit}</strong>。
          </p>
          {failed.wantHint && <p className="vdm__result-line">{failed.wantHint}</p>}
          <p className="vdm__result-line vdm__result-line--dim">
            整条会话作废（这是刻意的：三关连着过，错一关就重来）。
          </p>
          <button type="button" className="cdm__btn" onClick={() => void start()}>
            再来一次
          </button>
        </section>
      )}

      {phase === 'passed' && (
        <section className="vdm__result vdm__result--good">
          <div className="vdm__trophy">🎉</div>
          <h2 className="vdm__result-title">三关全过</h2>
          <p className="vdm__result-line">指令都读懂了。</p>
          <button type="button" className="cdm__btn" onClick={() => void start()}>
            再挑战一次
          </button>
        </section>
      )}

      {error && <p className="cdm__error">{error}</p>}

      {(phase === 'playing' || phase === 'loading') && (
        <div className="cdm__actions">
          <button
            type="button"
            className="cdm__btn cdm__btn--ghost"
            onClick={() => void start()}
            disabled={phase === 'loading'}
          >
            换一题
          </button>
        </div>
      )}
    </div>
  );
}
