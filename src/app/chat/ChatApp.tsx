'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ChatChannelDTO, ChatMessageDTO } from '@/lib/chat-shared';
import { CHAT_LOBBY_ID, CHAT_LOBBY_TITLE, CHAT_DELETED_TEXT } from '@/lib/chat-shared';
import NewChatModal from './NewChatModal';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

function toast(message: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(message, type);
}

const POLL_MS = 4000;
// SVG 不在内联展示白名单：raw 路由对 SVG 强制 Content-Disposition: attachment
// （防内联脚本执行的 XSS 设计），<img> 内联渲染必然失败，聊天场景只收位图。
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ApiEnvelope = { code: number; message: string; [k: string]: unknown };

async function api(url: string, init?: RequestInit): Promise<ApiEnvelope> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
  });
  return (await res.json().catch(() => ({ code: res.status, message: '请求失败' }))) as ApiEnvelope;
}

function fmtTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function userKey(u: { id: string; username: string }): string {
  return u.id;
}

// ── 消息气泡 ────────────────────────────────────────────────────────────────

function MessageItem({
  msg,
  isMine,
  canDelete,
  onReply,
  onDelete,
}: {
  msg: ChatMessageDTO;
  isMine: boolean;
  canDelete: boolean;
  onReply: (m: ChatMessageDTO) => void;
  onDelete: (m: ChatMessageDTO) => void;
}) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className={`chat-msg${isMine ? ' chat-msg--mine' : ''}`}>
      <Link className="chat-msg__avatar" href={`/u/${msg.author.id}`}>
        <img src={msg.author.avatar_url} alt={msg.author.username} loading="lazy" />
      </Link>
      <div className="chat-msg__body">
        <div className="chat-msg__meta">
          <Link className="chat-msg__name" href={`/u/${msg.author.id}`}>
            {msg.author.username}
          </Link>
          <span className="chat-msg__time">{fmtTime(msg.created_at)}</span>
          <span className="chat-msg__actions">
            {!msg.is_deleted && (
              <button type="button" className="chat-msg__btn" onClick={() => onReply(msg)}>
                回复
              </button>
            )}
            {canDelete && (
              <button type="button" className="chat-msg__btn chat-msg__btn--danger" onClick={() => onDelete(msg)}>
                删除
              </button>
            )}
          </span>
        </div>

        {msg.reply && (
          <div className="chat-msg__reply">
            <span className="chat-msg__reply-name">{msg.reply.author_name ?? ''}：</span>
            <span className="chat-msg__reply-text">{msg.reply.content}</span>
          </div>
        )}

        <div className="chat-msg__content">
          {msg.is_deleted ? (
            <span className="chat-msg__deleted">{msg.content}</span>
          ) : (
            msg.content
          )}
        </div>

        {msg.image && !imgError && (
          <img
            className="chat-msg__image"
            src={msg.image.url}
            alt="聊天图片"
            loading="lazy"
            onClick={() => window.open(msg.image!.url, '_blank', 'noopener')}
            onError={() => setImgError(true)}
          />
        )}
        {msg.image_missing && <div className="chat-msg__image-missing">[图片已删除]</div>}
      </div>
    </div>
  );
}

// ── 侧栏 ────────────────────────────────────────────────────────────────────

function SidebarRow({
  ch,
  active,
  onClick,
}: {
  ch: ChatChannelDTO;
  active: boolean;
  onClick: () => void;
}) {
  const isLobby = ch.kind === 'lobby';
  return (
    <button
      type="button"
      className={`chat-chan${active ? ' is-active' : ''}${ch.unread_count > 0 ? ' has-unread' : ''}`}
      onClick={onClick}
      title={ch.title}
    >
      {isLobby ? (
        <span className="chat-chan__icon" aria-hidden="true">
          💬
        </span>
      ) : (
        <span className="chat-chan__avatar">
          <img src={`/api/avatar/${ch.peer?.id ?? ''}`} alt="" loading="lazy" />
        </span>
      )}
      <span className="chat-chan__main">
        <span className="chat-chan__title">{ch.title}</span>
        <span className="chat-chan__preview">
          {ch.last_message
            ? `${ch.last_message.author_name ? ch.last_message.author_name + '：' : ''}${ch.last_message.content}`
            : isLobby
              ? '来聊聊吧'
              : '开始对话'}
        </span>
      </span>
      {ch.unread_count > 0 && <span className="chat-chan__badge">{ch.unread_count > 99 ? '99+' : ch.unread_count}</span>}
    </button>
  );
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

export default function ChatApp({
  currentUserId,
  isAdmin,
  initialChannel,
}: {
  currentUserId: string;
  isAdmin: boolean;
  initialChannel: string | null;
}) {
  const router = useRouter();

  const [channels, setChannels] = useState<ChatChannelDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialChannel);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [pendingImage, setPendingImage] = useState<{ id: string; url: string } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ChatMessageDTO | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastIdRef = useRef<number>(0);
  const viewTokenRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeId) ?? null,
    [channels, activeId]
  );

  useEffect(() => {
    const stored = localStorage.getItem('chat.sidebarCollapsed');
    if (stored === '1') setSidebarCollapsed(true);
  }, []);

  // ── 已读 ────────────────────────────────────────────────────────────────
  const markRead = useCallback(
    async (channelId: string, upTo: number) => {
      if (!upTo || !document.hasFocus() || document.hidden) return;
      try {
        await api(`/api/chat/channels/${channelId}/read`, {
          method: 'POST',
          body: JSON.stringify({ message_id: upTo }),
        });
        setChannels((prev) =>
          prev.map((c) => (c.id === channelId ? { ...c, unread_count: 0 } : c))
        );
      } catch {
        /* 已读失败不阻塞 */
      }
    },
    []
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }, []);

  // ── 拉消息（初始 / 切频道） ────────────────────────────────────────────
  const loadMessages = useCallback(
    async (channelId: string, token: number) => {
      const data = await api(`/api/chat/channels/${channelId}/messages`);
      if (data.code !== 200 || !Array.isArray(data.messages)) return;
      if (token !== viewTokenRef.current || channelId !== activeRef.current) return;
      const list = data.messages as ChatMessageDTO[];
      setMessages(list);
      setHasMore(list.length >= 50);
      const maxId = list.length ? list[list.length - 1].id : 0;
      lastIdRef.current = maxId;
      setNewCount(0);
      requestAnimationFrame(() => scrollToBottom());
      if (maxId) void markRead(channelId, maxId);
    },
    [markRead, scrollToBottom]
  );

  // ── 轮询 ───────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    if (document.hidden) return;
    const token = viewTokenRef.current;
    const aid = activeRef.current;
    const maxId = lastIdRef.current;
    const qs = new URLSearchParams();
    if (aid && maxId > 0) {
      qs.set('channel', aid);
      qs.set('after', String(maxId));
    }
    const data = await api(`/api/chat/poll${qs.toString() ? `?${qs.toString()}` : ''}`);
    if (data.code !== 200) return;
    if (Array.isArray(data.channels)) setChannels(data.channels as ChatChannelDTO[]);

    const newMsgs = data.messages as ChatMessageDTO[] | undefined;
    if (
      aid &&
      newMsgs &&
      newMsgs.length &&
      token === viewTokenRef.current &&
      data.channel_id === aid
    ) {
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = newMsgs.filter((m) => !seen.has(m.id));
        if (!fresh.length) return prev;
        const merged = [...prev, ...fresh];
        lastIdRef.current = Math.max(...merged.map((m) => m.id));
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
          if (document.hasFocus()) void markRead(aid, lastIdRef.current);
        } else {
          setNewCount((n) => n + fresh.length);
        }
        return merged;
      });
    }
  }, [isNearBottom, markRead, scrollToBottom]);

  useEffect(() => {
    const iv = setInterval(() => void poll(), POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  // ── 首次加载：频道列表 + 选定初始频道 ─────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await api('/api/chat/poll');
      if (!alive || data.code !== 200) return;
      const list = (data.channels ?? []) as ChatChannelDTO[];
      setChannels(list);
      const want = initialChannel ?? CHAT_LOBBY_ID;
      const target = list.some((c) => c.id === want)
        ? want
        : list.length
          ? list[0].id
          : CHAT_LOBBY_ID;
      setActiveId(target);
      activeRef.current = target;
      const token = ++viewTokenRef.current;
      await loadMessages(target, token);
      if (target !== CHAT_LOBBY_ID) {
        router.replace(`/chat?channel=${encodeURIComponent(target)}`, { scroll: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialChannel, loadMessages, router]);

  // ── 切频道 ─────────────────────────────────────────────────────────────
  const selectChannel = useCallback(
    (id: string) => {
      if (id === activeRef.current) return;
      setActiveId(id);
      activeRef.current = id;
      setMessages([]);
      setReplyTarget(null);
      setPendingImage(null);
      setNewCount(0);
      setDrawerOpen(false);
      lastIdRef.current = 0;
      const token = ++viewTokenRef.current;
      router.replace(`/chat?channel=${encodeURIComponent(id)}`, { scroll: false });
      void loadMessages(id, token);
    },
    [loadMessages, router]
  );

  // ── 发送 ───────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const aid = activeRef.current;
    if (!aid || sending) return;
    const content = text.trim();
    if (!content && !pendingImage) {
      toast('消息内容不能为空', 'info');
      return;
    }
    if (content.length > (pendingImage ? 500 : 1000)) {
      toast(pendingImage ? '图注不能超过500字' : '消息不能超过1000字', 'info');
      return;
    }
    setSending(true);
    try {
      const data = await api(`/api/chat/channels/${aid}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content,
          ...(pendingImage ? { image_id: pendingImage.id } : {}),
          ...(replyTarget ? { reply_to: replyTarget.id } : {}),
        }),
      });
      if (data.code === 200) {
        const m = data.message as unknown as ChatMessageDTO;
        if (typeof m.id === 'number') {
          setMessages((prev) => [...prev, m]);
          lastIdRef.current = m.id;
          setText('');
          setPendingImage(null);
          setReplyTarget(null);
          setNewCount(0);
          requestAnimationFrame(() => scrollToBottom());
          if (document.hasFocus()) void markRead(aid, m.id);
        }
      } else {
        toast(data.message || '发送失败', 'error');
      }
    } catch {
      toast('发送失败，请重试', 'error');
    } finally {
      setSending(false);
    }
  }, [sending, text, pendingImage, replyTarget, markRead, scrollToBottom]);

  // ── 加载更早 ───────────────────────────────────────────────────────────
  const loadOlder = useCallback(async () => {
    const aid = activeRef.current;
    if (!aid || loadingOlder) return;
    const oldest = messagesRef.current[0]?.id;
    if (oldest == null) return;
    setLoadingOlder(true);
    try {
      const data = await api(`/api/chat/channels/${aid}/messages?before=${oldest}`);
      if (data.code !== 200 || !Array.isArray(data.messages)) return;
      const older = data.messages as ChatMessageDTO[];
      if (!older.length) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => [...older, ...prev]);
      setHasMore(older.length >= 50);
    } catch {
      /* 忽略 */
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder]);

  // ── 图片上传（走图床） ────────────────────────────────────────────────
  const pickImage = useCallback(
    async (file: File) => {
      if (file.size > MAX_IMAGE_BYTES) {
        toast('图片不能超过 10MB', 'error');
        return;
      }
      if (!IMAGE_ACCEPT.split(',').includes(file.type)) {
        toast('仅支持 PNG / JPEG / GIF / WebP', 'error');
        return;
      }
      setUploadingImage(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('compress', '1');
        const data = await api('/api/images', { method: 'POST', body: fd });
        if (data.code === 200 && typeof data.id === 'string' && typeof data.url === 'string') {
          setPendingImage({ id: data.id, url: data.url });
        } else {
          toast(data.message || '图片上传失败', 'error');
        }
      } catch {
        toast('图片上传失败，请重试', 'error');
      } finally {
        setUploadingImage(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    []
  );

  // ── 删除 ───────────────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (m: ChatMessageDTO) => {
      const mine = m.author.id === currentUserId;
      let reason: string | undefined;
      if (mine) {
        if (!confirm('确定删除这条消息吗？')) return;
      } else if (isAdmin) {
        const r = prompt('删除他人消息需要填写原因（1-500字）：');
        if (r === null) return;
        if (!r.trim()) {
          toast('请填写删除原因', 'error');
          return;
        }
        reason = r.trim();
      } else {
        toast('无权删除该消息', 'error');
        return;
      }
      try {
        const data = await api(`/api/chat/messages/${m.id}`, {
          method: 'DELETE',
          body: JSON.stringify(reason !== undefined ? { reason } : {}),
        });
        if (data.code === 200) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === m.id
                ? { ...x, is_deleted: true, content: CHAT_DELETED_TEXT, image: null, image_missing: false }
                : x
            )
          );
          toast('已删除', 'success');
        } else {
          toast(data.message || '删除失败', 'error');
        }
      } catch {
        toast('删除失败，请重试', 'error');
      }
    },
    [currentUserId, isAdmin]
  );

  // ── 发起私聊（弹窗回调） ──────────────────────────────────────────────
  const onDirectCreated = useCallback(
    (ch: ChatChannelDTO) => {
      setChannels((prev) => {
        const idx = prev.findIndex((c) => c.id === ch.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = ch;
          return next;
        }
        return [ch, ...prev];
      });
      setModalOpen(false);
      setActiveId(ch.id);
      activeRef.current = ch.id;
      setMessages([]);
      setReplyTarget(null);
      setPendingImage(null);
      setNewCount(0);
      setDrawerOpen(false);
      lastIdRef.current = 0;
      const token = ++viewTokenRef.current;
      router.replace(`/chat?channel=${encodeURIComponent(ch.id)}`, { scroll: false });
      void loadMessages(ch.id, token);
    },
    [loadMessages, router]
  );

  return (
    <div className={`chat-page${sidebarCollapsed ? ' chat-page--collapsed' : ''}${drawerOpen ? ' chat-page--drawer-open' : ''}`}>
      {/* 侧栏 */}
      <aside className="chat-sidebar" aria-label="会话列表">
        <div className="chat-sidebar__head">
          <span className="chat-sidebar__title">聊天</span>
          <button
            type="button"
            className="chat-sidebar__collapse"
            onClick={() => setSidebarCollapsed((v) => {
              localStorage.setItem('chat.sidebarCollapsed', v ? '0' : '1');
              return !v;
            })}
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>

        <div className="chat-sidebar__list">
          {channels.map((c) => (
            <SidebarRow
              key={userKey({ id: c.id, username: c.title })}
              ch={c}
              active={c.id === activeId}
              onClick={() => selectChannel(c.id)}
            />
          ))}
          {channels.length === 0 && <div className="chat-sidebar__empty">加载中…</div>}
        </div>

        <div className="chat-sidebar__foot">
          <button type="button" className="chat-new-btn" onClick={() => setModalOpen(true)}>
            <span aria-hidden="true">＋</span>
            {!sidebarCollapsed && <span>发起私聊</span>}
          </button>
        </div>
      </aside>

      {/* 消息主区 */}
      <main className="chat-main">
        {activeChannel ? (
          <>
            <header className="chat-main__head">
              <button
                type="button"
                className="chat-main__menu"
                onClick={() => setDrawerOpen((v) => !v)}
                aria-label="切换会话列表"
              >
                ☰
              </button>
              {activeChannel.kind === 'direct' && activeChannel.peer && (
                <Link className="chat-main__peer-avatar" href={`/u/${activeChannel.peer.id}`}>
                  <img src={`/api/avatar/${activeChannel.peer.id}`} alt="" />
                </Link>
              )}
              <h1 className="chat-main__title">
                {activeChannel.kind === 'direct'
                  ? activeChannel.peer?.username ?? '私聊'
                  : CHAT_LOBBY_TITLE}
              </h1>
              {activeChannel.kind === 'direct' && activeChannel.peer && (
                <Link className="chat-main__profile-link" href={`/u/${activeChannel.peer.id}`}>
                  个人资料 →
                </Link>
              )}
              {activeChannel.kind === 'lobby' && (
                <span className="chat-main__subtitle">核心用户及以上 · 所有人可见</span>
              )}
            </header>

            <div className="chat-list" ref={listRef}>
              {hasMore && messages.length > 0 && (
                <button type="button" className="chat-list__older" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? '加载中…' : '加载更早的消息'}
                </button>
              )}
              {messages.length === 0 && (
                <div className="chat-list__empty">
                  {activeChannel.kind === 'lobby' ? '聊天大区空荡荡，说点什么吧' : '还没有消息，打个招呼吧'}
                </div>
              )}
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  msg={m}
                  isMine={m.author.id === currentUserId}
                  canDelete={m.author.id === currentUserId || isAdmin}
                  onReply={(t) => {
                    setReplyTarget(t);
                  }}
                  onDelete={handleDelete}
                />
              ))}
            </div>

            {newCount > 0 && (
              <button type="button" className="chat-jump-new" onClick={() => {
                scrollToBottom('smooth');
                if (lastIdRef.current) void markRead(activeRef.current!, lastIdRef.current);
                setNewCount(0);
              }}>
                {newCount} 条新消息 ↓
              </button>
            )}

            <div className="chat-composer">
              {replyTarget && (
                <div className="chat-composer__reply">
                  <span className="chat-composer__reply-text">
                    回复 {replyTarget.author.username}：{replyTarget.content}
                  </span>
                  <button type="button" className="chat-composer__reply-close" onClick={() => setReplyTarget(null)} aria-label="取消回复">
                    ×
                  </button>
                </div>
              )}
              {pendingImage && (
                <div className="chat-composer__image">
                  <img src={pendingImage.url} alt="待发送图片" />
                  <button
                    type="button"
                    className="chat-composer__image-remove"
                    onClick={() => setPendingImage(null)}
                    aria-label="移除图片"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="chat-composer__row">
                <input
                  ref={fileRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickImage(f);
                  }}
                />
                <button
                  type="button"
                  className="chat-composer__img-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadingImage}
                  title="上传图片（图床）"
                >
                  {uploadingImage ? '…' : '🖼'}
                </button>
                <textarea
                  className="chat-composer__input"
                  rows={1}
                  placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  type="button"
                  className="chat-composer__send"
                  onClick={() => void send()}
                  disabled={sending || !activeId}
                >
                  {sending ? '发送中…' : '发送'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="chat-main__empty">加载中…</div>
        )}
      </main>

      {modalOpen && (
        <NewChatModal
          onClose={() => setModalOpen(false)}
          onCreated={onDirectCreated}
          currentUserId={currentUserId}
        />
      )}
    </div>
  );
}