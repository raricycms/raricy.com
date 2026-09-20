'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Avatar from '@/app/components/Avatar';

// 头像框的装备面板。
//
// 【数据全部来自服务端判定】`GET /api/users/me/frame` 回的是**判定后的结果**：
//   · url      —— 已过白名单 / 未退役 / 未过期 / 盘上有素材，四道闸都过了才有值
//   · expired  —— 服务端算好的布尔
//   · active   —— 当前装备的那个框「现在真的显示着吗」
// 本组件**不做任何时间比较**。这不是纪律洁癖：db-time-guard 的规则 3–5 扫整个 src/
//（含页面组件），在这里写 `new Date(expires_at) > new Date()` 会被静态守卫直接判红。
//
// 【为什么改完要 router.refresh()】框会显示在**服务端渲染**的页面里（顶栏、博客列表、
// 讨论侧栏），软导航不会重跑 root layout —— 不 refresh 的话用户会以为没生效。
// 与专注模式那次保存同款（见 page.tsx 里 saveFocus 的注释）。

interface MyFrame {
  key: string;
  label: string;
  description: string;
  retired: boolean;
  available: boolean;
  url: string | null;
  expiresAt: string | null;
  expired: boolean;
  equipped: boolean;
}

interface Equipped {
  key: string;
  label: string;
  active: boolean;
  expiresAt: string | null;
}

interface Props {
  /** 预览要叠在**你自己的头像**上 —— 这是唯一让人看出「戴上去什么样」的办法。 */
  userId: string;
  onAlert: (kind: 'success' | 'danger', msg: string) => void;
}

export default function FramePanel({ userId, onAlert }: Props) {
  const router = useRouter();
  const [frames, setFrames] = useState<MyFrame[] | null>(null);
  const [equipped, setEquipped] = useState<Equipped | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/users/me/frame', { credentials: 'same-origin' });
      const json = (await res.json()) as { frames?: MyFrame[]; equipped?: Equipped | null };
      setFrames(json.frames ?? []);
      setEquipped(json.equipped ?? null);
    } catch {
      setFrames([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** key = null 表示卸下。 */
  const setFrame = useCallback(
    async (key: string | null, label: string) => {
      setBusy(key ?? '__none__');
      try {
        const res = await fetch('/api/users/me/frame', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          // 显式传 null（不是省略字段）—— 服务端把「没传」与「传了 null」当两件事
          body: JSON.stringify({ frame_key: key }),
        });
        const json = (await res.json()) as { code: number; message: string };
        if (json.code !== 200) {
          onAlert('danger', json.message);
          return;
        }
        onAlert('success', key ? `已戴上「${label}」` : '已摘下头像框');
        await load();
        // 顶栏 / 博客列表 / 讨论侧栏都是服务端渲染的，必须 refresh 才会重画
        router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [load, onAlert, router]
  );

  if (frames === null) return <p className="frame-panel__hint">加载中…</p>;

  const currentUrl = frames.find((f) => f.key === equipped?.key)?.url ?? null;

  return (
    <div className="frame-panel">
      {/* ── 当前装备 ── */}
      <div className="frame-panel__current">
        <Avatar userId={userId} frameUrl={currentUrl} alt="我的头像" size={72} />
        <div className="frame-panel__current-meta">
          {equipped ? (
            <>
              <span className="frame-panel__current-name">{equipped.label}</span>
              <span className="frame-panel__current-state">
                {equipped.active
                  ? equipped.expiresAt
                    ? `${equipped.expiresAt} 到期`
                    : '永久'
                  : equipped.expiresAt
                    ? `已于 ${equipped.expiresAt} 过期`
                    : '已下架'}
              </span>
              {/* 卸下**无条件可用** —— 包括已过期 / 已下架 / 已不在白名单的那些框。
                  没有这个按钮，一个退役的 key 就会变成摘不掉的僵尸装备。 */}
              <button
                type="button"
                className="settings-btn"
                disabled={busy !== null}
                onClick={() => void setFrame(null, equipped.label)}
              >
                摘下
              </button>
            </>
          ) : (
            <span className="frame-panel__current-state">还没有戴任何头像框</span>
          )}
        </div>
      </div>

      {frames.length === 0 ? (
        <p className="frame-panel__hint">
          站长还没有给你发过头像框。头像框由站长发放，不需要你申请。
        </p>
      ) : (
        <ul className="frame-panel__grid">
          {frames.map((f) => (
            <li
              key={f.key}
              className={`frame-panel__item${f.equipped ? ' frame-panel__item--on' : ''}`}
            >
              <Avatar userId={userId} frameUrl={f.url} alt="" size={56} />
              <div className="frame-panel__meta">
                <span className="frame-panel__name">{f.label}</span>
                {/* 到期与状态徽标挤在一行 —— 各占一行会把卡片撑得很高，
                    而它们本来就是同一个问题的两面（「这个框还能不能用」） */}
                <span className="frame-panel__sub">
                  <span className="frame-panel__expiry">
                    {f.expiresAt ? `${f.expiresAt} 到期` : '永久'}
                  </span>
                  {/* 三种「戴着也看不见」的原因要分开说 —— 用户据此刻判断该找谁 */}
                  {f.expired && <span className="frame-panel__badge">已过期</span>}
                  {f.retired && <span className="frame-panel__badge">已下架</span>}
                  {!f.available && !f.retired && (
                    <span className="frame-panel__badge" title="素材还没传到服务器">
                      素材缺失
                    </span>
                  )}
                </span>
              </div>
              {f.equipped ? (
                <span className="frame-panel__on-tag">佩戴中</span>
              ) : (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={busy !== null || f.retired || f.expired}
                  onClick={() => void setFrame(f.key, f.label)}
                >
                  戴上
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
