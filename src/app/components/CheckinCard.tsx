'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { LeaderboardEntry } from '@/lib/checkin-service';

// ── 全局 toast（原站 base.js 注入 window.showToast） ──────────────────────────
function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

// ── 运势文案映射（对齐原站 FORTUNE_LABELS） ─────────────────────────────────
const FORTUNE_LABELS: Record<number, string> = {
  1: '平平淡淡也是真',
  2: '小有运气',
  3: '运势不错',
  4: '好运连连',
  5: '运势爆棚 ',
};

const CARD_COUNT = 5;
type BtnPhase = 'idle' | 'loading' | 'success' | 'done';

interface Props {
  checkedIn: boolean;
  totalCount: number;
  totalFortune: number;
  fortuneValue: number | null;
  fortunePending: boolean;
  today: string;
  username: string;
}

export default function CheckinCard({
  checkedIn,
  totalCount,
  totalFortune,
  fortuneValue,
  fortunePending,
  today,
  username,
}: Props) {
  const router = useRouter();

  const [count, setCount] = useState(totalCount);
  const [fortune, setFortune] = useState(totalFortune);
  const [todayFortune, setTodayFortune] = useState<number | null>(fortuneValue);
  const [countBounce, setCountBounce] = useState(false);
  const [fortuneBounce, setFortuneBounce] = useState(false);

  const [btnPhase, setBtnPhase] = useState<BtnPhase>(checkedIn ? 'done' : 'idle');

  // 运势弹窗状态
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPending, setModalPending] = useState(false); // true = 恢复态「继续完成签到」
  const [isRevealed, setIsRevealed] = useState(false); // 已选牌，锁定后续点击
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [flipped, setFlipped] = useState<boolean[]>(() => Array(CARD_COUNT).fill(false));
  const [revealed, setRevealed] = useState(false);
  const [backs, setBacks] = useState<string[]>(() => Array(CARD_COUNT).fill(''));
  const [showResult, setShowResult] = useState(false);
  const [resultValue, setResultValue] = useState<number | null>(null);
  const [resultPop, setResultPop] = useState(false);
  const [pool, setPool] = useState<number[]>([]);
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);

  const doneRef = useRef(checkedIn); // 本次会话是否已完成签到
  // 签到成功时（先签到后翻牌）暂存服务端已抽好的运势，供翻牌动画使用
  const drawnRef = useRef<{ fortuneValue: number; pool: number[] } | null>(null);
  const busyRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timers.current.forEach(clearTimeout);
    };
  }, []);
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      if (mounted.current) fn();
    }, ms);
    timers.current.push(t);
  };

  // 已签到但未翻牌（恢复态）→ 进页短暂延时后自动弹出运势卡（对齐 Flask fortune_pending）
  useEffect(() => {
    if (!fortunePending) return;
    const t = setTimeout(() => {
      if (!mounted.current) return;
      resetCards();
      setModalPending(true);
      setModalOpen(true);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fortunePending]);

  // 弹窗打开时锁定滚动（对齐 document.body.style.overflow）
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = modalOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [modalOpen]);

  // Esc 关闭弹窗（对齐原站 keydown 监听）
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  function resetCards() {
    setIsRevealed(false);
    setSelectedIdx(null);
    setFlipped(Array(CARD_COUNT).fill(false));
    setRevealed(false);
    setBacks(Array(CARD_COUNT).fill(''));
    setShowResult(false);
    setResultValue(null);
    setResultPop(false);
    setPool([]);
    setChosenIndex(null);
  }

  function bounceCount() {
    setCountBounce(false);
    requestAnimationFrame(() => setCountBounce(true));
  }
  function bounceFortune() {
    setFortuneBounce(false);
    requestAnimationFrame(() => setFortuneBounce(true));
  }

  // 点击「每日签到」→ 先签到（API 请求中按钮显示「⏳ 签到中...」）→ 成功 toast +
  // 按钮转「今日已签到」→ 约 1.3s 后弹出运势卡（对齐 Flask 的先签到后翻牌时序）。
  async function doCheckinFlow() {
    if (doneRef.current || busyRef.current || modalOpen) return;
    busyRef.current = true;
    setBtnPhase('loading');

    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (data.code === 200) {
        // 签到成功 —— 服务端已抽好运势，暂存供翻牌动画使用
        doneRef.current = true;
        drawnRef.current = { fortuneValue: data.fortune_value, pool: data.pool ?? [] };
        toast(data.message || '签到成功！', 'success');
        setBtnPhase('success');
        setFortune(data.total_fortune ?? fortune);
        later(() => setBtnPhase('done'), 1050);
        // 约 1.3s 后弹出运势卡（全新签到态）
        later(() => {
          resetCards();
          setModalPending(false);
          setModalOpen(true);
        }, 1300);
      } else if (data.code === 401) {
        setBtnPhase('idle');
        toast('登录已过期，请重新登录', 'error');
        later(() => {
          window.location.href = '/login';
        }, 1500);
      } else if (data.already_checked) {
        // 今天已签到 —— 直接进已签到态
        doneRef.current = true;
        setBtnPhase('done');
        if (data.total_count != null) setCount(data.total_count);
        toast(data.message || '今天已签到', 'info');
      } else {
        setBtnPhase('idle');
        toast(data.message || '操作失败，请稍后重试', 'error');
      }
    } catch {
      setBtnPhase('idle');
      toast('网络异常，请稍后重试', 'error');
    } finally {
      busyRef.current = false;
    }
  }

  // 翻牌动画：让被点的牌显示抽中的运势值，700ms 后揭示其余牌，1500ms 后展示结果区。
  function runRevealAnimation(i: number, fv: number, drawnPool: number[]) {
    // 把 fv 换到位置 i，保证被点的牌翻出的正是抽中值
    const display = [...drawnPool];
    const cur = display.indexOf(fv);
    if (cur !== -1 && cur !== i) {
      [display[i], display[cur]] = [display[cur], display[i]];
    }

    // Step 1：翻开所选牌
    setBacks((prev) => {
      const b = [...prev];
      b[i] = String(fv);
      return b;
    });
    setFlipped((prev) => {
      const f = [...prev];
      f[i] = true;
      return f;
    });
    setSelectedIdx(null);

    // Step 2：700ms 后揭示其余牌
    later(() => {
      setRevealed(true);
      setBacks(display.map(String));
      setFlipped(Array(CARD_COUNT).fill(true));
    }, 700);

    // Step 3：1500ms 后展示结果区
    later(() => {
      setPool(display);
      setChosenIndex(i);
      setResultValue(fv);
      setTodayFortune(fv);
      setShowResult(true);
      requestAnimationFrame(() => setResultPop(true));
      // 累计天数 +1（仅全新签到，恢复态不加）
      if (!modalPending) {
        setCount((c) => c + 1);
        bounceCount();
      }
    }, 1500);
  }

  // 选牌 → 翻牌动画。全新签到态：运势已在签到时抽好，仅做动画；恢复态：调用合并 API 补抽。
  async function selectCard(i: number) {
    if (isRevealed) return;
    setIsRevealed(true);
    setSelectedIdx(i);

    if (drawnRef.current) {
      const { fortuneValue, pool } = drawnRef.current;
      runRevealAnimation(i, fortuneValue, pool);
      return;
    }

    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chosenIndex: i }),
      });
      const data = await res.json();

      if (data.code !== 200) {
        if (data.code === 401) {
          toast('登录已过期，请重新登录', 'error');
          later(() => {
            window.location.href = '/login';
          }, 1500);
          return;
        }
        setIsRevealed(false);
        setSelectedIdx(null);
        toast(data.message || '出错了，请重试', 'error');
        return;
      }

      doneRef.current = true;
      setFortune(data.total_fortune ?? fortune);
      runRevealAnimation(i, data.fortune_value, data.pool ?? []);
    } catch {
      setIsRevealed(false);
      setSelectedIdx(null);
      toast('网络异常，请稍后重试', 'error');
    }
  }

  function closeModal() {
    setModalOpen(false);
    setModalPending(false);
    if (doneRef.current) {
      // 刷新排行榜/统计（服务端组件重取）+ 顶栏签到绿点
      router.refresh();
      const w = window as unknown as { updateCheckinIndicator?: () => void };
      if (w.updateCheckinIndicator) w.updateCheckinIndicator();
      bounceFortune();
    } else {
      // 未完成签到 —— 恢复按钮可点
      setBtnPhase('idle');
    }
  }

  const done = btnPhase === 'done' || doneRef.current;
  const btnClass =
    'checkin-button' +
    (btnPhase === 'loading' ? ' checkin-button--popping' : '') +
    (btnPhase === 'success' ? ' checkin-button--success' : '') +
    (btnPhase === 'done' ? ' checkin-button--done' : '');
  const btnText =
    btnPhase === 'loading'
      ? '⏳ 签到中...'
      : btnPhase === 'success'
        ? ''
        : done
          ? '今日已签到'
          : '每日签到';

  return (
    <div className="checkin-card">
      <div className="checkin-card__header">
        <span className="checkin-card__greeting">你好，{username}</span>
        <span className="checkin-card__date">{today}</span>
      </div>

      <button
        className={btnClass}
        onClick={doCheckinFlow}
        disabled={done || btnPhase === 'loading' || btnPhase === 'success' || modalOpen}
      >
        <span
          className={
            'checkin-button__particles' +
            (btnPhase === 'success' ? ' checkin-button__particles--active' : '')
          }
        />
        {btnText}
      </button>

      <div className="checkin-stats">
        <div className="checkin-stats__item">
          <div className={'checkin-stats__value' + (countBounce ? ' checkin-stats__value--bounce' : '')}>
            {count}
          </div>
          <div className="checkin-stats__label">累计签到天数</div>
        </div>
        <div className="checkin-stats__item">
          <div
            className={
              'checkin-stats__value checkin-stats__value--fortune' +
              (fortuneBounce ? ' checkin-stats__value--bounce' : '')
            }
          >
            {fortune}
          </div>
          <div className="checkin-stats__label">总运势值</div>
        </div>
      </div>

      {todayFortune != null && (
        <div className="checkin-today-fortune">
          <span className="checkin-today-fortune__label">今日运势</span>
          <span className={`checkin-today-fortune__value fortune-color--${todayFortune}`}>
            {todayFortune}
          </span>
        </div>
      )}

      {/* 运势弹窗 */}
      <div className={'fortune-modal' + (modalOpen ? ' fortune-modal--open' : '')}>
        <div className="fortune-modal__backdrop" onClick={closeModal} />
        <div className="fortune-modal__content">
          <div className="fortune-modal__header">
            <h3>{modalPending ? '🃏 继续完成签到' : '签到成功！'}</h3>
            <p>{modalPending ? '上次签到还未选牌，选择一张运势卡吧' : '选择一张运势卡，看看今天的运气如何'}</p>
          </div>

          {!showResult && (
            <div className="fortune-cards">
              {Array.from({ length: CARD_COUNT }).map((_, i) => (
                <div
                  key={i}
                  className={
                    'fortune-card' +
                    (flipped[i] ? ' fortune-card--flipped' : '') +
                    (revealed ? ' fortune-card--revealed' : '') +
                    (selectedIdx === i ? ' fortune-card--selected' : '')
                  }
                  style={
                    {
                      '--card-index': i,
                      pointerEvents: isRevealed ? 'none' : undefined,
                    } as React.CSSProperties
                  }
                  onClick={() => selectCard(i)}
                >
                  <div className="fortune-card__inner">
                    <div className="fortune-card__front">?</div>
                    <div className="fortune-card__back">{backs[i]}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {showResult && (
            <div className="fortune-modal__result">
              <div
                className={
                  'fortune-modal__result-value fortune-color--' +
                  resultValue +
                  (resultPop ? ' fortune-modal__result-value--pop' : '')
                }
              >
                {resultValue}
              </div>
              <div className="fortune-modal__result-desc">
                {resultValue != null ? FORTUNE_LABELS[resultValue] ?? '' : ''}
              </div>
              <div className="fortune-modal__pool-reveal">
                <div className="fortune-mini-cards">
                  {pool.map((val, i) => (
                    <span
                      key={i}
                      className={
                        'fortune-mini-card' +
                        (i === chosenIndex ? ` fortune-mini-card--chosen fortune-color--${val}` : '')
                      }
                    >
                      {val}
                    </span>
                  ))}
                </div>
              </div>
              <button className="fortune-modal__close-btn" onClick={closeModal}>
                知道了
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 排行榜（单容器 + 天数/运势 双 tab 切换，对齐原站 switchLeaderboardTab） ──
const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const RANK_CLASS: Record<number, string> = {
  1: ' checkin-leaderboard__rank--top1',
  2: ' checkin-leaderboard__rank--top2',
  3: ' checkin-leaderboard__rank--top3',
};

function LeaderboardList({
  entries,
  unit,
  emptyText,
  currentUserId,
}: {
  entries: LeaderboardEntry[];
  unit: string;
  emptyText: string;
  currentUserId: string;
}) {
  if (entries.length === 0) {
    return <div className="checkin-empty">{emptyText}</div>;
  }
  return (
    <div className="checkin-leaderboard__list">
      {entries.map((e) => (
        <div
          key={e.userId}
          className={
            'checkin-leaderboard__item' +
            (e.userId === currentUserId ? ' checkin-leaderboard__item--self' : '')
          }
        >
          <span className={`checkin-leaderboard__rank${RANK_CLASS[e.rank] ?? ''}`}>
            {MEDAL[e.rank] ?? `#${e.rank}`}
          </span>
          <Link className="checkin-leaderboard__user" href={`/u/${e.userId}`}>
            {e.avatarPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="checkin-leaderboard__avatar" src={`/api/avatar/${e.userId}`} alt="" />
            ) : (
              <span className="checkin-leaderboard__avatar-placeholder" />
            )}
            <span className="checkin-leaderboard__name">{e.username}</span>
          </Link>
          <span className="checkin-leaderboard__count">
            {e.value} {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CheckinLeaderboards({
  countEntries,
  fortuneEntries,
  currentUserId,
}: {
  countEntries: LeaderboardEntry[];
  fortuneEntries: LeaderboardEntry[];
  currentUserId: string;
}) {
  const [tab, setTab] = useState<'count' | 'fortune'>('count');

  return (
    <div className="checkin-leaderboard">
      <div className="checkin-leaderboard__tabs">
        <button
          type="button"
          className={
            'checkin-leaderboard__tab' + (tab === 'count' ? ' checkin-leaderboard__tab--active' : '')
          }
          onClick={() => setTab('count')}
        >
          签到天数榜
        </button>
        <button
          type="button"
          className={
            'checkin-leaderboard__tab' + (tab === 'fortune' ? ' checkin-leaderboard__tab--active' : '')
          }
          onClick={() => setTab('fortune')}
        >
          运势榜
        </button>
      </div>

      <div
        className={
          'checkin-leaderboard__panel' + (tab === 'count' ? ' checkin-leaderboard__panel--active' : '')
        }
      >
        <LeaderboardList
          entries={countEntries}
          unit="天"
          emptyText="还没有人签到，快来抢占第一名吧！"
          currentUserId={currentUserId}
        />
      </div>

      <div
        className={
          'checkin-leaderboard__panel' + (tab === 'fortune' ? ' checkin-leaderboard__panel--active' : '')
        }
      >
        <LeaderboardList
          entries={fortuneEntries}
          unit="运势"
          emptyText="暂无运势数据，快去签到吧！"
          currentUserId={currentUserId}
        />
      </div>
    </div>
  );
}
