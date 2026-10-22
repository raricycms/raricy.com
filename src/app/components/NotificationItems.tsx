'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { NotificationDTO } from '@/lib/notification-service';
import { CHAT_NOTIFY_OBJECT_TYPE } from '@/lib/chat-shared';
import Avatar from './Avatar';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

function toast(message: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(message, type);
}

// ─────────────────────────────────────────────────────────────────────────────
// 通知页的视觉分类
//
// 通知的 action 是**自由文本**（管理员定向通知直接写中文），所以这里只是一张
// 「认得的 action → 图标 + 色相」的偏好表，认不出来的一律落到 `default`（铃铛 +
// 中性色），绝不能因为漏登记而把某条通知藏掉或渲染成空白。
//
// 色相用分类色（--color-accent-*），只有「点赞 / 删除 / 禁言」借语义色：
//   · 点赞在本站一直是 warning 红（与文章卡片的点赞胶囊同色），不是「危险」；
//   · 删除 / 禁言确实是警示，借 warning 红名正言顺。
// 图标容器的底色一律取同色系的 -soft 档，明暗主题都跟着令牌走。
// ─────────────────────────────────────────────────────────────────────────────
type NotificationTone =
  | 'like'
  | 'comment'
  | 'mention'
  | 'feed'
  | 'appeal'
  | 'warning'
  | 'system'
  | 'default';

interface NotificationVisual {
  /** 站内 mask 图标类名（public/static/img/icons，填充版）；尺寸由 _notifications.scss 给。 */
  icon: string;
  tone: NotificationTone;
}

function visualForAction(action: string): NotificationVisual {
  switch (action) {
    case '文章点赞':
      return { icon: 'icon-heart-fill', tone: 'like' };
    case '评论回复':
    case '文章评论':
      return { icon: 'icon-chat-dots', tone: 'comment' };
    case '评论提及':
    case '讨论提及':
      return { icon: 'icon-at', tone: 'mention' };
    case '文章投喂':
      return { icon: 'icon-fish', tone: 'feed' };
    case '申诉提交':
    case '申诉结果':
      return { icon: 'icon-scale', tone: 'appeal' };
    case '禁言通知':
    case '解除禁言':
    case '强制下线':
    case '文章删除':
    case '图片删除':
    case '音频删除':
      return { icon: 'icon-shield-alert', tone: 'warning' };
    case '系统公告':
    case '功能更新':
    case '维护通知':
    case '活动通知':
    case '栏目发文提醒':
    case '用户提醒':
      return { icon: 'icon-megaphone', tone: 'system' };
    default:
      return { icon: 'icon-bell-fill', tone: 'default' };
  }
}

const TONE_CLASS: Record<NotificationTone, string> = {
  like: 'notification-type--like',
  comment: 'notification-type--comment',
  mention: 'notification-type--mention',
  feed: 'notification-type--feed',
  appeal: 'notification-type--appeal',
  warning: 'notification-type--warning',
  system: 'notification-type--system',
  default: 'notification-type--default',
};

/**
 * 匿名评论留下的通知：`actorId` 是 null（匿名评论只在 detail 里留化名），
 * 这几类不显示「系统」—— 那会把「匿名读者」读成站务通知。
 * 其余 actor 为空的（系统公告、管理员自由文本）才是真的「系统」。
 */
const ANONYMOUS_ACTOR_ACTIONS = new Set(['评论回复', '文章评论', '评论提及']);

/**
 * 通知的去处。只认我们真的知道目标是什么的几种：
 *   · blog            → 文章详情（文章已被删除的那条不给链接 —— 点进去只会 404）
 *   · chat_channel    → 讨论会话（objectId 是频道 id，租不到消息级锚点，见 chat-service）
 *   · admin_action_log→ 操作公示详情（「申诉提交」通知的 objectId 就是日志 id）
 * 其余（user / system / appeal / 自由文本）没有可靠落点，宁可不给链接。
 */
function destinationFor(n: NotificationDTO): { href: string; label: string } | null {
  if (!n.object.id) return null;
  if (n.object.type === 'blog') {
    if (n.action === '文章删除') return null;
    return { href: `/blog/${n.object.id}`, label: '查看文章' };
  }
  if (n.object.type === CHAT_NOTIFY_OBJECT_TYPE) {
    return {
      href: `/chat?channel=${encodeURIComponent(n.object.id)}`,
      label: '查看讨论',
    };
  }
  if (n.object.type === 'admin_action_log') {
    return { href: `/audit/${n.object.id}`, label: '查看操作日志' };
  }
  return null;
}

/** 只显示时分：日期由分组标题交代（今天 / 昨天 / 10月18日）。 */
function fmtTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * `<time datetime>` 给机器读。库内是「UTC+8 墙上时间贴 Z」（见 db-time.ts），
 * 直接吐出去会被当成 UTC 瞬间，差 8 小时；换成真实偏移后数字不变、瞬间才正确。
 */
function machineTime(ts: string | null): string | undefined {
  if (!ts) return undefined;
  return ts.replace(/Z$/, '+08:00');
}

const WEEKDAYS = '日一二三四五六';

function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return '今天';
  if (key === yesterdayKey) return '昨天';
  const [y, m, d] = key.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()];
  return y === Number(todayKey.slice(0, 4))
    ? `${m}月${d}日 周${weekday}`
    : `${y}年${m}月${d}日`;
}

interface DayGroup {
  key: string;
  label: string;
  items: NotificationDTO[];
}

function groupByDay(items: NotificationDTO[], todayKey: string, yesterdayKey: string): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const n of items) {
    // timestamp 是墙钟时间的 ISO 串，前 10 位就是墙钟日期，不参与时区换算。
    const key = n.timestamp ? n.timestamp.slice(0, 10) : 'unknown';
    if (!current || current.key !== key) {
      current = { key, label: key === 'unknown' ? '更早' : dayLabel(key, todayKey, yesterdayKey), items: [] };
      groups.push(current);
    }
    current.items.push(n);
  }
  return groups;
}

interface Props {
  initial: NotificationDTO[];
  /** all = 全部；unread = 只看未读（服务端已按 unreadOnly 过滤）。 */
  filter: 'all' | 'unread';
  initialTotal: number;
  initialUnread: number;
  /** 服务端算出的「今天」（UTC+8 墙钟日期），保证 SSR 与客户端分组一致。 */
  today: string;
}

// 通知列表：初始数据由 Server Component 注入。标记已读 / 删除都走 API 后就地更新 UI。
//
// 层级按「类型 → 正文 → 身份 / 操作」排：action 是眉标（小号、次要色），detail 是
// 正文（主字号、主色），actor 与时间是页脚（更小、次要色）。时间只在卡片右上角露
// 时分，日期交给分组标题 —— 这样「什么时候」「谁」与「发生了什么」不会挤在同一行
// 用同一个字号说话。
export default function NotificationItems({
  initial,
  filter,
  initialTotal,
  initialUnread,
  today,
}: Props) {
  const [items, setItems] = useState<NotificationDTO[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState<string | null>(null); // 正在处理的 id / 'all' / 'read'

  const unreadOnly = filter === 'unread';
  const yesterday = new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000;
  const groups = groupByDay(items, today, new Date(yesterday).toISOString().slice(0, 10));

  async function markOne(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        // 未读筛选下，读过的那条已经不属于这个视图，直接移出列表；
        // 全部筛选下留在原地，只把未读态摘掉。
        setItems((prev) =>
          unreadOnly ? prev.filter((n) => n.id !== id) : prev.map((n) => (n.id === id ? { ...n, read: true } : n))
        );
        setUnread((prev) => Math.max(0, prev - 1));
        if (unreadOnly) setTotal((prev) => Math.max(0, prev - 1));
        toast('已标记为已读', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function markAll() {
    if (busy) return;
    if (!confirm('确定要标记所有通知为已读吗？')) return;
    setBusy('all');
    try {
      const res = await fetch('/api/notifications/read-all', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => (unreadOnly ? [] : prev.map((n) => ({ ...n, read: true }))));
        setUnread(0);
        if (unreadOnly) setTotal(0);
        toast(data.message ?? '已全部标记为已读', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteOne(id: string) {
    if (busy) return;
    if (!confirm('确定要删除这个通知吗？此操作不可恢复！')) return;
    const target = items.find((n) => n.id === id);
    setBusy(id);
    try {
      const res = await fetch(`/api/notifications/${id}/delete`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.filter((n) => n.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        if (target && !target.read) setUnread((prev) => Math.max(0, prev - 1));
        toast('通知已删除', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteRead() {
    if (busy) return;
    if (!confirm('确定要删除所有已读通知吗？此操作不可恢复！')) return;
    setBusy('read');
    try {
      const res = await fetch('/api/notifications/delete-read', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.filter((n) => !n.read));
        // count 是**全站**已读条数，不只本页 —— 总数要按它减，否则翻页后计数会漂。
        const deleted = typeof data.count === 'number' ? data.count : 0;
        setTotal((prev) => Math.max(0, prev - deleted));
        toast(data.message ?? '已删除已读通知', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="notifications-summary">
        {unreadOnly ? (
          <>
            未读通知 <span className="numeric">{unread}</span> 条
          </>
        ) : (
          <>
            共 <span className="numeric">{total}</span> 条通知 ·{' '}
            <span className="numeric">{unread}</span> 条未读
          </>
        )}
      </p>

      <div className="notifications-toolbar">
        <nav className="notifications-filters" aria-label="通知筛选">
          <Link
            href="/notifications"
            className={`notifications-filter${filter === 'all' ? ' is-active' : ''}`}
            aria-current={filter === 'all' ? 'page' : undefined}
          >
            全部
          </Link>
          <Link
            href="/notifications?filter=unread"
            className={`notifications-filter${filter === 'unread' ? ' is-active' : ''}`}
            aria-current={filter === 'unread' ? 'page' : undefined}
          >
            未读
            {unread > 0 && <span className="notifications-filter__count numeric">{unread}</span>}
          </Link>
        </nav>

        <div className="notifications-bulk">
          <button
            type="button"
            className="notifications-bulk__btn"
            onClick={markAll}
            disabled={busy !== null || unread === 0}
          >
            <span className="icon icon-check-double" aria-hidden="true" />
            全部已读
          </button>
          <button
            type="button"
            className="notifications-bulk__btn notifications-bulk__btn--danger"
            onClick={deleteRead}
            disabled={busy !== null}
          >
            <span className="icon icon-trash-fill" aria-hidden="true" />
            删除已读
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <span className="icon icon-bell-fill" aria-hidden="true" />
          </div>
          <h3>{unreadOnly ? '没有未读通知' : '暂无通知'}</h3>
          <p>{unreadOnly ? '所有通知都读过了。' : '你还没有收到任何通知。'}</p>
          {unreadOnly && (
            <Link href="/notifications" className="notifications-empty-link">
              查看全部通知
            </Link>
          )}
        </div>
      ) : (
        <div className="notifications-list">
          {groups.map((group) => (
            <section key={group.key} className="notification-day" aria-label={group.label}>
              <h2 className="notification-day__label">{group.label}</h2>
              <div className="notification-day__list">
                {group.items.map((n) => {
                  const visual = visualForAction(n.action);
                  const dest = destinationFor(n);
                  return (
                    <article
                      key={n.id}
                      className={`notification-card${n.read ? '' : ' unread'}`}
                      data-id={n.id}
                      aria-busy={busy === n.id || undefined}
                    >
                      <span
                        className={`notification-type ${TONE_CLASS[visual.tone]}`}
                        aria-hidden="true"
                      >
                        <span className={`icon ${visual.icon}`} aria-hidden="true" />
                      </span>

                      <div className="notification-body">
                        <div className="notification-head">
                          <span className="notification-action">{n.action}</span>
                          {!n.read && <span className="notification-unread-badge">未读</span>}
                          {n.timestamp && (
                            <time
                              className="notification-time numeric"
                              dateTime={machineTime(n.timestamp)}
                            >
                              {fmtTime(n.timestamp)}
                            </time>
                          )}
                        </div>

                        {n.detail && <p className="notification-content">{n.detail}</p>}

                        <div className="notification-foot">
                          {n.actor.id ? (
                            <Link href={`/u/${n.actor.id}`} className="notification-actor">
                              <Avatar
                                userId={n.actor.id}
                                frameUrl={n.actor.frameUrl}
                                alt={n.actor.username ?? ''}
                                className="notification-actor__avatar"
                              />
                              <span className="notification-actor__name">{n.actor.username}</span>
                            </Link>
                          ) : ANONYMOUS_ACTOR_ACTIONS.has(n.action) ? null : (
                            <span className="notification-actor">
                              <span className="notification-actor__glyph" aria-hidden="true">
                                <span className="icon icon-bell-fill" aria-hidden="true" />
                              </span>
                              系统
                            </span>
                          )}

                          <div className="notification-actions">
                            {dest && (
                              <Link href={dest.href} className="notification-open">
                                {dest.label}
                                <span className="icon icon-arrow-right" aria-hidden="true" />
                              </Link>
                            )}
                            {!n.read && (
                              <button
                                type="button"
                                className="notification-action-btn"
                                onClick={() => markOne(n.id)}
                                disabled={busy !== null}
                                aria-label="标记为已读"
                                title="标记为已读"
                              >
                                <span className="icon icon-check" aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="notification-action-btn notification-action-btn--danger"
                              onClick={() => deleteOne(n.id)}
                              disabled={busy !== null}
                              aria-label="删除通知"
                              title="删除通知"
                            >
                              <span className="icon icon-trash-fill" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
