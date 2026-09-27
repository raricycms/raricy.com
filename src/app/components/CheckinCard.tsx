'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import { MedalIcon } from '@/app/components/MedalIcon';
import Avatar from '@/app/components/Avatar';
import type { LeaderboardEntry } from '@/lib/checkin-service';

// ── 全局 toast（base.js 注入 window.showToast） ──────────────────────────────
function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

type BtnPhase = 'idle' | 'loading' | 'success' | 'done';

interface Props {
  checkedIn: boolean;
  totalCount: number;
  /** 今天已经到手的签到鱼干（服务端读流水给的真值）。 */
  todayFish: number;
  /** 签一次给多少（服务端常量，别在这儿另写一个数）。 */
  rewardFish: number;
  today: string;
  username: string;
}

export default function CheckinCard({
  checkedIn,
  totalCount,
  todayFish,
  rewardFish,
  today,
  username,
}: Props) {
  const router = useRouter();

  const [count, setCount] = useState(totalCount);
  const [fishToday, setFishToday] = useState(todayFish);
  const [countBounce, setCountBounce] = useState(false);

  const [btnPhase, setBtnPhase] = useState<BtnPhase>(checkedIn ? 'done' : 'idle');

  const doneRef = useRef(checkedIn); // 本次会话是否已完成签到
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

  function bounceCount() {
    setCountBounce(false);
    requestAnimationFrame(() => setCountBounce(true));
  }

  // 点击「每日签到」→ 签到 + 到账是一个请求、一个事务（服务端把建记录与发鱼干
  // 一起提交）。成功或「今天已签到」都直接进已签到态 —— 没有第二步要等。
  async function doCheckinFlow() {
    if (doneRef.current || busyRef.current) return;
    busyRef.current = true;
    setBtnPhase('loading');

    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json();

      if (data.code === 200) {
        doneRef.current = true;
        toast(data.message || '签到成功！', 'success');
        setBtnPhase('success');
        later(() => setBtnPhase('done'), 1050);
        if (data.total_count != null) {
          setCount(data.total_count);
          bounceCount();
        }
        if (data.today_fish != null) setFishToday(data.today_fish);
        // 排行榜（服务端组件）与顶栏签到绿点跟着更新
        router.refresh();
        const w = window as unknown as { updateCheckinIndicator?: () => void };
        if (w.updateCheckinIndicator) w.updateCheckinIndicator();
      } else if (data.code === 401) {
        setBtnPhase('idle');
        toast('登录已过期，请重新登录', 'error');
        later(() => {
          window.location.href = '/login';
        }, 1500);
      } else if (data.already_checked) {
        // 今天已签到（另一个标签页签的 / 本页 state 落后）—— 直接进已签到态
        doneRef.current = true;
        setBtnPhase('done');
        if (data.total_count != null) setCount(data.total_count);
        if (data.today_fish != null) setFishToday(data.today_fish);
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

  const done = btnPhase === 'done' || doneRef.current;
  const btnClass =
    'checkin-button' +
    (btnPhase === 'loading' ? ' checkin-button--popping' : '') +
    (btnPhase === 'success' ? ' checkin-button--success' : '') +
    (btnPhase === 'done' ? ' checkin-button--done' : '');
  const btnText =
    btnPhase === 'loading' ? (
      <>
        <LoaderCircle className="spin" aria-hidden="true" /> 签到中…
      </>
    ) : btnPhase === 'success' ? (
      ''
    ) : done ? (
      '今日已签到'
    ) : (
      '每日签到'
    );

  return (
    <div className="checkin-card">
      <div className="checkin-card__header">
        <span className="checkin-card__greeting">你好，{username}</span>
        <span className="checkin-card__date">{today}</span>
      </div>

      <button
        className={btnClass}
        onClick={doCheckinFlow}
        disabled={done || btnPhase === 'loading' || btnPhase === 'success'}
      >
        <span
          className={
            'checkin-button__particles' +
            (btnPhase === 'success' ? ' checkin-button__particles--active' : '')
          }
        />
        {btnText}
      </button>

      {/* 统计只有签到天数一格 */}
      <div className="checkin-stats">
        <div className="checkin-stats__item">
          <div className={'checkin-stats__value' + (countBounce ? ' checkin-stats__value--bounce' : '')}>
            {count}
          </div>
          <div className="checkin-stats__label">累计签到天数</div>
        </div>
      </div>

      {/* 今天到手多少 —— **读服务端真值**（流水），不按常量推算：奖励将来若改，
          今天已签的人也不会看到「按新数字算出来」的假账。
          没签到、或签过但没到账（本行是历史遗留）时不渲染，别写一个骗人的 0。 */}
      {fishToday > 0 ? (
        <div className="checkin-today-reward">
          <span className="checkin-today-reward__label">今日签到获得</span>
          <span className="checkin-today-reward__value">+{fishToday}</span>
          <span className="checkin-today-reward__label">小鱼干</span>
        </div>
      ) : (
        <div className="checkin-reward-hint">每天签到领 {rewardFish} 条小鱼干</div>
      )}
    </div>
  );
}

// ── 排行榜 ──
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
            {e.rank >= 1 && e.rank <= 3 ? (
              <MedalIcon rank={e.rank as 1 | 2 | 3} />
            ) : (
              `#${e.rank}`
            )}
          </span>
          <Link className="checkin-leaderboard__user" href={`/u/${e.userId}`}>
            {/* 此前这里按 `e.avatarPath` 分支 —— 而那一列**永远是 null**（本站没有
              * 头像上传入口），所以排行榜一直显示灰方块占位。那个判据本身也是错的：
              * 磁盘上的遗留头像文件跟这一列毫无关系（读口会自己找到它们）。
              * <Avatar> 走同一条永不 404 的读口，不需要任何分支。 */}
            <Avatar
              userId={e.userId}
              frameUrl={e.frameUrl}
              alt=""
              imgClassName="checkin-leaderboard__avatar"
            />
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

// 只剩签到天数榜 —— 早先「签到天数榜 / 累计值榜」的双 tab 已随后者一起下线。
export function CheckinLeaderboards({
  countEntries,
  currentUserId,
}: {
  countEntries: LeaderboardEntry[];
  currentUserId: string;
}) {
  return (
    <div className="checkin-leaderboard">
      <h3 className="checkin-leaderboard__title">签到天数榜</h3>
      <LeaderboardList
        entries={countEntries}
        unit="天"
        emptyText="还没有人签到，快来抢占第一名吧！"
        currentUserId={currentUserId}
      />
    </div>
  );
}
