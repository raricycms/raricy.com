'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowDown, ArrowRight, Menu } from 'lucide-react';
import type { ChatChannelDTO, ChatMessageDTO, ChatStreamEvent } from '@/lib/chat-shared';
import {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  CHAT_PREVIEW_MAX,
} from '@/lib/chat-shared';
import { LS_KEY, COOKIE_NAME, COOKIE_MAX_AGE } from '@/lib/chat-sidebar-pref';
import NewChatModal from './NewChatModal';
import QuoteBlogModal from './QuoteBlogModal';
import AvatarMenu, { type AvatarMenuAnchor } from './AvatarMenu';
import ChatMessageItem, { dayKey, fmtDay } from './ChatMessageItem';
import ChatSidebar from './ChatSidebar';
import ChatComposer, { IMAGE_ACCEPT, type ComposerBlogQuote } from './ChatComposer';
import ChatSearchModal, { SearchButton } from './ChatSearchModal';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

function toast(message: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(message, type);
}

/**
 * 低频对账间隔。实时消息走 SSE（/api/chat/stream），这里只负责「以服务端为准」的
 * 兜底：未读数、最后一条预览、别人新发起的会话、成员变更。SSE 断了也能靠它自愈。
 */
const RECONCILE_MS = 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** DOM 上限：同时在 DOM 里的消息条数（超出从顶部折叠，消息仍在内存里）。 */
const DOM_CAP = 300;
/** 折叠后点一次「展开更早」放回的条数。 */
const REVEAL_STEP = 50;
/** 同人连续消息的合并窗口（分钟）。 */
const GROUP_WINDOW_MIN = 5;

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

/** 两条消息相差多少分钟（时间戳缺失/非法时返回 Infinity，即不合并）。 */
function minutesApart(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(tb - ta) / 60000;
}

/**
 * 侧栏预览文案。口径与服务端 listChannelsForUser 保持一致（拍一拍 / [图片] / [博客] /
 * 截断），这样 SSE 推送本地累加的预览与下一次对账拉回的服务端预览不会跳变。
 */
function previewOfMessage(m: ChatMessageDTO): string {
  if (m.pat) return `拍了拍 ${m.pat.target_name}`;
  const collapsed = m.content.replace(/\s+/g, ' ').trim();
  const display = collapsed || (m.image ? '[图片]' : m.blog ? '[博客]' : '');
  return display.length > CHAT_PREVIEW_MAX ? `${display.slice(0, CHAT_PREVIEW_MAX)}…` : display;
}


// ── 主组件 ──────────────────────────────────────────────────────────────────

export default function ChatApp({
  currentUserId,
  currentUsername,
  isAdmin,
  initialChannel,
  initialSidebarCollapsed = false,
  initialFocusMode = false,
}: {
  currentUserId: string;
  currentUsername: string;
  isAdmin: boolean;
  initialChannel: string | null;
  /** SSR 首屏折叠态：/chat 服务端页读 chat_sidebar_collapsed cookie 传入（见 chat-sidebar-pref.ts） */
  initialSidebarCollapsed?: boolean;
  /** 专注模式（服务端按 user.focusMode 传入）：大区行禁用、默认不落大区 */
  initialFocusMode?: boolean;
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
  /** 引用博客草稿（单附件：再选即替换） */
  const [blogQuote, setBlogQuote] = useState<ComposerBlogQuote | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  /** 头像选项框：锚点信息（头像按钮矩形）在点击瞬间实测 */
  const [avatarMenu, setAvatarMenu] = useState<
    { author: ChatMessageDTO['author']; anchor: AvatarMenuAnchor } | null
  >(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 首次频道列表加载完成（区分「加载中」与「专注模式空态」） */
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  /** 当前会话的消息搜索弹窗 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 正在输入的人（仅当前频道，3.5 秒无新信号自动移除） */
  const [typingNames, setTypingNames] = useState<string[]>([]);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const textRef = useRef(text);
  textRef.current = text;
  /** 按频道暂存输入框草稿：切走时存、切回时恢复（否则给 A 打一半切到 B 会误发）。 */
  const draftsRef = useRef<Map<string, string>>(new Map());
  /** 本地已读地板：频道 → 已确认读到的最新消息 id（用于压制对账响应造成的未读回跳）。 */
  const readFloorRef = useRef<Map<string, number>>(new Map());
  /** 跳转高亮：当前被锚点/搜索命中的消息 id（2 秒后自动清除）。 */
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** DOM 上限：从顶部折叠掉的消息条数（内存里仍在）。 */
  const [foldedCount, setFoldedCount] = useState(0);
  /** 进入频道时的已读位置：「以下是新消息」分隔线的锚点。 */
  const unreadAnchorRef = useRef(0);
  /** 上次上报「正在输入」的时刻（客户端 2 秒节流，服务端另有 3 秒兜底） */
  const lastTypingSentRef = useRef(0);
  /** `${channelId}:${userId}` → 自动淡出定时器 */
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastIdRef = useRef<number>(0);
  const viewTokenRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === activeId) ?? null,
    [channels, activeId]
  );

  // DOM 上限：只渲染最后 (总条数 − 折叠数) 条。
  // 自动折叠只增不减（展开由按钮主动减），切频道时 messages 归零 → 折叠数自动失效。
  // 已读回执只标「我发出的最后一条」（私聊里最有用，且不需要逐条渲染状态）
  const lastMineId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].author.id === currentUserId) return messages[i].id;
    }
    return null;
  }, [messages, currentUserId]);
  const peerLastRead = activeChannel?.peer_last_read_message_id ?? 0;

  const maxFold = Math.max(0, messages.length - DOM_CAP);
  const folded = Math.min(foldedCount, maxFold);
  const visibleMessages = folded > 0 ? messages.slice(folded) : messages;

  useEffect(() => {
    if (maxFold > foldedCount) setFoldedCount(maxFold);
  }, [maxFold, foldedCount]);

  // ── 侧栏折叠偏好（对齐 blog.sort 的镜像模型）──────────────────────────────
  // localStorage 长命记忆；cookie（chat_sidebar_collapsed，只存 '1'=折叠）是 SSR
  // 可见镜像，/chat 首屏由服务端按 cookie 直出折叠态，不再「先展开再折叠」跳变。
  // 折叠/展开切换双写；cookie 缺失 + LS='1' 只在旧存量（cookie 镜像引入前或
  // ITP 清 cookie 后）时补建并折叠一次 —— 此后 SSR 首帧即折叠，不再翻转。
  const lsCollapsed = (): boolean => {
    try {
      return localStorage.getItem(LS_KEY) === '1';
    } catch {
      return false; // 隐私模式/被禁 → 放弃记忆，按默认展开走
    }
  };
  const cookieCollapsed = (): boolean => {
    try {
      return document.cookie.split('; ').some((c) => c.startsWith(`${COOKIE_NAME}=1`));
    } catch {
      return false;
    }
  };
  const writeCookie = (collapsed: boolean) => {
    try {
      document.cookie = collapsed
        ? `${COOKIE_NAME}=1; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
        : `${COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`;
    } catch {
      // cookie 不可用 → 放弃镜像，行为同旧版（每次进入折叠一次）
    }
  };
  const persistCollapsed = (collapsed: boolean) => {
    try {
      localStorage.setItem(LS_KEY, collapsed ? '1' : '0');
    } catch {
      // localStorage 不可用 → 本次会话内折叠仍生效，只是不记忆
    }
    writeCookie(collapsed);
  };

  useEffect(() => {
    if (!cookieCollapsed() && lsCollapsed()) {
      writeCookie(true); // 先补 cookie：StrictMode 双跑时第二次已命中 cookie，幂等
      setSidebarCollapsed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 已读 ────────────────────────────────────────────────────────────────
  const markRead = useCallback(
    async (channelId: string, upTo: number) => {
      if (!upTo || !document.hasFocus() || document.hidden) return;
      // 本地已读地板：对账返回的未读数若还没反映这次已读，就用它压成 0，
      // 避免「刚清掉的徽标被一个更早发出的响应盖回来」的闪烁。
      readFloorRef.current.set(channelId, upTo);
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
  /** 拉频道首页消息（纯网络，不落状态）。 */
  const fetchMessages = useCallback(async (channelId: string): Promise<ChatMessageDTO[] | null> => {
    const data = await api(`/api/chat/channels/${channelId}/messages`);
    if (data.code !== 200 || !Array.isArray(data.messages)) return null;
    return data.messages as ChatMessageDTO[];
  }, []);

  /**
   * 把首页消息落进状态（游标 / 已读 / 滚动）。
   *
   * @param sync 同步提交（flushSync）并同步滚到底。频道切换的 View Transition 必须
   *   走这条路：过渡进行中浏览器既不渲染也不派发 requestAnimationFrame（实测回调里
   *   等 rAF 会一直等到 4 秒超时被 abort），所以「新快照」拍到的必须是这一帧里已经
   *   提交好的 DOM 与滚动位置 —— 否则拍到的是空列表 / 顶部。
   */
  const commitMessages = useCallback(
    (channelId: string, list: ChatMessageDTO[], token: number, sync = false) => {
      if (token !== viewTokenRef.current || channelId !== activeRef.current) return;
      const maxId = list.length ? list[list.length - 1].id : 0;
      lastIdRef.current = maxId;
      unreadAnchorRef.current = maxId; // 「以下是新消息」分隔线的锚点
      const apply = () => {
        setMessages(list);
        setHasMore(list.length >= 50);
        setNewCount(0);
      };
      if (sync) {
        flushSync(apply);
        scrollToBottom(); // DOM 已同步更新，直接滚到底
      } else {
        apply();
        requestAnimationFrame(() => scrollToBottom());
      }
      if (maxId) void markRead(channelId, maxId);
    },
    [markRead, scrollToBottom]
  );

  const loadMessages = useCallback(
    async (channelId: string, token: number, sync = false) => {
      const list = await fetchMessages(channelId);
      if (list) commitMessages(channelId, list, token, sync);
    },
    [fetchMessages, commitMessages]
  );

  // ── 对账（低频兜底）────────────────────────────────────────────────────
  // 实时消息走 SSE（见下）；这里只把「频道列表」拉回服务端口径：未读数、最后一条
  // 预览、别人新发起的会话、成员变更。SSE 断了也能靠它自愈。
  const reconcile = useCallback(async () => {
    if (document.hidden) return;
    const data = await api('/api/chat/poll');
    if (data.code !== 200) return;
    if (Array.isArray(data.channels)) {
      // 已读地板合并：服务端未读还没反映刚提交的已读时，本地先按 0 显示。
      // 判据：我已读到的 id ≥ 该频道最后一条消息 id ⇒ 必然没有未读。
      const merged = (data.channels as ChatChannelDTO[]).map((c) => {
        const floor = readFloorRef.current.get(c.id) ?? 0;
        const lastId = c.last_message?.id ?? 0;
        return floor > 0 && lastId > 0 && floor >= lastId ? { ...c, unread_count: 0 } : c;
      });
      setChannels(merged);
      setChannelsLoaded(true);
    }
  }, []);

  /** 重新拉当前频道首页（SSE 发来 resync：积压太久、补齐窗口不够）。 */
  const reloadActive = useCallback(() => {
    const aid = activeRef.current;
    if (!aid) return;
    const token = ++viewTokenRef.current;
    void loadMessages(aid, token);
  }, [loadMessages]);

  /**
   * 追加一条消息（按 id 去重）。同一条消息会从两条链路回来：发送接口的响应、
   * SSE 推给自己的回声（多标签页同步要靠它）—— 谁先谁后都可能，所以两条路径
   * 必须共用这一个入口，否则同一条消息会出现两个气泡（同 id，React key 也撞）。
   * 返回 false 表示列表里已有这条（调用方可以跳过滚动 / 未读等后续动作）。
   */
  const appendMessage = useCallback((m: ChatMessageDTO): boolean => {
    const prev = messagesRef.current;
    if (prev.some((x) => x.id === m.id)) return false;
    const merged = [...prev, m].sort((a, b) => a.id - b.id);
    messagesRef.current = merged;
    setMessages(merged);
    return true;
  }, []);

  /**
   * 收到一条实时消息。活动频道 → 合并进列表；其他频道 → 本地累加未读 + 更新预览
   * （下一次对账会以服务端为准，所以这里只是让侧栏「跟手」）。
   */
  const onStreamMessage = useCallback(
    (m: ChatMessageDTO) => {
      const aid = activeRef.current;
      if (m.channel_id === aid) {
        // 自己发的也会被推回来；发送响应可能已经先到 → 按 id 去重（见 appendMessage）
        if (!appendMessage(m)) return;
        lastIdRef.current = Math.max(lastIdRef.current, m.id);
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
          if (document.hasFocus()) void markRead(aid, m.id);
        } else {
          setNewCount((n) => n + 1);
        }
        return;
      }

      // 非活动频道：自己的消息（其他标签页发的）/ 已删消息都不算未读
      if (m.author.id === currentUserId || m.is_deleted) return;
      if (!channelsRef.current.some((c) => c.id === m.channel_id)) {
        void reconcile(); // 列表里还没有这个会话（别人新发起的私聊）→ 拉一次
        return;
      }
      setChannels((prev) =>
        prev.map((c) =>
          c.id !== m.channel_id
            ? c
            : {
                ...c,
                unread_count: c.unread_count + 1,
                last_message: {
                  id: m.id,
                  content: previewOfMessage(m),
                  author_name: m.author.username,
                  created_at: m.created_at,
                },
              }
        )
      );
    },
    [appendMessage, currentUserId, isNearBottom, markRead, reconcile, scrollToBottom]
  );

  const onTypingEvent = useCallback(
    (ev: { channel_id: string; user_id: string; username: string }) => {
      if (ev.channel_id !== activeRef.current || ev.user_id === currentUserId) return;
      const key = `${ev.channel_id}:${ev.user_id}`;
      const timers = typingTimersRef.current;
      const prev = timers.get(key);
      if (prev) clearTimeout(prev);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setTypingNames((names) => names.filter((n) => n !== ev.username));
        }, 3500)
      );
      setTypingNames((names) => (names.includes(ev.username) ? names : [...names, ev.username]));
    },
    [currentUserId]
  );

  // ── SSE 连接生命周期 ────────────────────────────────────────────────────
  // 标签页隐藏时主动断开：浏览器对同一源的并发连接数有硬上限（HTTP/1.1 为 6），
  // 一条 SSE 就占一条，而且这个池子是**跨标签页共享**的 —— 隐藏的标签页不该占坑。
  // 回到前台重连，服务端按 Last-Event-ID 补齐期间漏掉的消息。
  useEffect(() => {
    let es: EventSource | null = null;

    const openStream = () => {
      if (es || document.hidden) return;
      const src = new EventSource('/api/chat/stream');
      es = src;
      src.onopen = () => {
        // 首连时若还没有任何消息游标（初始加载尚未回来），补拉一次当前频道 ——
        // 关掉「消息查询快照 → 订阅建立」之间的空窗。重连有 Last-Event-ID 补齐，
        // 不需要（也避免把正在翻历史的用户拽回底部）。
        if (lastIdRef.current === 0) reloadActive();
      };
      src.onmessage = (e) => {
        let ev: ChatStreamEvent;
        try {
          ev = JSON.parse(e.data as string) as ChatStreamEvent;
        } catch {
          return;
        }
        if (ev.type === 'message') onStreamMessage(ev.message);
        else if (ev.type === 'typing') onTypingEvent(ev);
        else if (ev.type === 'read') {
          // 私聊已读回执：更新对方的读游标（只对本频道有意义）
          setChannels((prev) =>
            prev.map((c) =>
              c.id === ev.channel_id ? { ...c, peer_last_read_message_id: ev.message_id } : c
            )
          );
        } else if (ev.type === 'resync') {
          reloadActive();
          void reconcile();
        }
      };
      // onerror 无需处理：浏览器按服务端下发的 retry 自动重连；
      // 被封禁/降权时服务端返回 403，EventSource 按规范直接关闭且不再重试。
    };

    const closeStream = () => {
      es?.close();
      es = null;
    };

    const onVisible = () => {
      if (document.hidden) {
        closeStream();
        return;
      }
      openStream();
      void reconcile();
    };

    openStream();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const iv = setInterval(() => void reconcile(), RECONCILE_MS);

    return () => {
      closeStream();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(iv);
    };
  }, [onStreamMessage, onTypingEvent, reconcile, reloadActive]);

  // ── 首次加载：频道列表 + 选定初始频道 ─────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await api('/api/chat/poll');
      if (!alive || data.code !== 200) return;
      const list = (data.channels ?? []) as ChatChannelDTO[];
      setChannels(list);
      setChannelsLoaded(true);
      // 选中策略：请求的频道可用（存在且未禁用）优先；否则退回第一个可用行；
      // 专注模式下大区行 disabled —— 想进 lobby / 没有私聊时落到 null（空态，
      // 主区展示专注提示；顺带清掉 URL 里残留的 ?channel=lobby 防止刷新死循环）。
      const want = initialChannel ?? CHAT_LOBBY_ID;
      const usable = list.filter((c) => !c.disabled);
      let target: string | null = null;
      if (usable.some((c) => c.id === want)) target = want;
      else if (usable.length) target = usable[0].id;
      setActiveId(target);
      activeRef.current = target;
      if (target === null) {
        if (initialChannel !== null) {
          router.replace('/chat', { scroll: false });
        }
        return;
      }
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

  // ── 草稿暂存 / 恢复（按频道） ────────────────────────────────────────────
  const stashDraft = useCallback((channelId: string | null) => {
    if (!channelId) return;
    const v = textRef.current;
    if (v) draftsRef.current.set(channelId, v);
    else draftsRef.current.delete(channelId);
  }, []);
  const restoreDraft = useCallback((channelId: string) => {
    setText(draftsRef.current.get(channelId) ?? '');
  }, []);

  // ── 切频道 ─────────────────────────────────────────────────────────────
  /**
   * 频道切换的「旧列表淡出、新列表淡入」。
   *
   * 用 View Transitions API：浏览器把切换前的列表拍成快照，新旧两张快照做交叉
   * 淡入淡出（动画在 _chat.scss 的 ::view-transition-* 里）。回调里要**等新消息
   * 拉回来再收尾** —— 否则淡入的是还没数据的空列表，消息随后才蹦出来；而这段
   * 等待期间浏览器不渲染、不派发 rAF，所以状态必须用 flushSync 同步提交
   * （见 commitMessages 的 sync 参数）。
   * 浏览器不支持该 API / 用户要求减少动效 → 直接切，行为与旧版一致。
   */
  const switchWithFade = useCallback(
    async (apply: () => void, load: () => Promise<unknown>) => {
      const doc = document as Document & {
        startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> };
      };
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      if (!doc.startViewTransition || reduceMotion) {
        apply();
        await load();
        return;
      }
      await doc
        .startViewTransition(async () => {
          flushSync(apply);
          await load();
        })
        .finished.catch(() => {
          /* 过渡被浏览器跳过/中断（连续切换）→ 忽略，状态早已提交 */
        });
    },
    []
  );

  const selectChannel = useCallback(
    (id: string) => {
      if (id === activeRef.current) return;
      void switchWithFade(
        () => {
          stashDraft(activeRef.current);
          setActiveId(id);
          activeRef.current = id;
          setMessages([]);
          setReplyTarget(null);
          setPendingImage(null);
          setBlogQuote(null);
          setNewCount(0);
          setDrawerOpen(false);
          setTypingNames([]);
          lastIdRef.current = 0;
          restoreDraft(id);
          router.replace(`/chat?channel=${encodeURIComponent(id)}`, { scroll: false });
        },
        () => {
          const token = ++viewTokenRef.current;
          return loadMessages(id, token, true); // sync：View Transition 的「新」快照要拍到新消息
        }
      );
    },
    [loadMessages, restoreDraft, router, stashDraft, switchWithFade]
  );

  // ── 防御：poll 拉回的频道行若带 disabled（例如另一标签页把专注模式打开了，
  // 而当前正停在大区）→ 自动切到第一个可用行，无可用则落空态。────────────
  useEffect(() => {
    const cur = channels.find((c) => c.id === activeId);
    if (!cur?.disabled) return;
    const next = channels.find((c) => !c.disabled);
    if (next) {
      selectChannel(next.id);
      return;
    }
    setMessages([]);
    lastIdRef.current = 0;
    setNewCount(0);
    setReplyTarget(null);
    setBlogQuote(null);
    setActiveId(null);
    activeRef.current = null;
    viewTokenRef.current++;
    router.replace('/chat', { scroll: false });
  }, [channels, activeId, router, selectChannel]);

  // ── 发送 ───────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const aid = activeRef.current;
    if (!aid || sending) return;
    const content = text.trim();
    // 博客引用视同附件（对齐带图消息）：允许空正文，文字上限 500
    const hasAttach = !!pendingImage || !!blogQuote;
    if (!content && !hasAttach) {
      toast('消息内容不能为空', 'info');
      return;
    }
    if (content.length > (hasAttach ? 500 : 1000)) {
      toast(hasAttach ? '图片或引用消息不能超过500字' : '消息不能超过1000字', 'info');
      return;
    }
    setSending(true);
    try {
      const data = await api(`/api/chat/channels/${aid}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content,
          ...(pendingImage ? { image_id: pendingImage.id } : {}),
          ...(blogQuote ? { blog_id: blogQuote.id } : {}),
          ...(replyTarget ? { reply_to: replyTarget.id } : {}),
        }),
      });
      if (data.code === 200) {
        const m = data.message as unknown as ChatMessageDTO;
        if (typeof m.id === 'number') {
          // SSE 回声可能已经先把这条推回来了 → 按 id 去重（见 appendMessage）
          appendMessage(m);
          lastIdRef.current = Math.max(lastIdRef.current, m.id);
          setText('');
          draftsRef.current.delete(aid); // 已发出 → 该频道草稿作废
          setPendingImage(null);
          setBlogQuote(null);
          setReplyTarget(null);
          setNewCount(0);
          // 文本框高度随内容自动加高过 → 发送后复位
          if (textareaRef.current) textareaRef.current.style.height = '';
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
  }, [appendMessage, sending, text, pendingImage, blogQuote, replyTarget, markRead, scrollToBottom]);

  // ── 拍一拍（头像选项框） ───────────────────────────────────────────────
  // 走发消息同一条接口（pat_target_id 非空即拍一拍）：复用频道访问校验与限频。
  const sendPat = useCallback(
    async (target: { id: string; username: string }) => {
      const aid = activeRef.current;
      if (!aid) return;
      try {
        const data = await api(`/api/chat/channels/${aid}/messages`, {
          method: 'POST',
          body: JSON.stringify({ pat_target_id: target.id }),
        });
        if (data.code === 200) {
          const m = data.message as unknown as ChatMessageDTO;
          if (typeof m.id === 'number') {
            // 同 send：SSE 回声可能先到 → 按 id 去重（见 appendMessage）
            appendMessage(m);
            lastIdRef.current = Math.max(lastIdRef.current, m.id);
            setNewCount(0);
            requestAnimationFrame(() => scrollToBottom());
            if (document.hasFocus()) void markRead(aid, m.id);
          }
        } else {
          toast(data.message || '拍一拍失败', 'error');
        }
      } catch {
        toast('拍一拍失败，请重试', 'error');
      }
    },
    [appendMessage, markRead, scrollToBottom]
  );

  // ── @ta：把「@用户名 」插到光标处（无光标则追加到末尾）────────────────────
  // 末尾那个空格是格式约定：消息渲染时也靠它做边界（见 isMentioned）。
  const insertMention = useCallback((username: string) => {
    const snippet = `@${username} `;
    const ta = textareaRef.current;
    if (!ta) {
      setText((t) => t + snippet);
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    setText(ta.value.slice(0, start) + snippet + ta.value.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + snippet.length;
      ta.setSelectionRange(caret, caret);
      // 程序化赋值不触发 onChange 的自动加高，这里补一次
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(176, ta.scrollHeight)}px`;
    });
  }, []);

  const openAvatarMenu = useCallback(
    (m: ChatMessageDTO, el: HTMLButtonElement) => {
      setAvatarMenu({
        author: m.author,
        anchor: { rect: el.getBoundingClientRect(), alignRight: m.author.id === currentUserId },
      });
    },
    [currentUserId]
  );

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

  // ── 正在输入 ────────────────────────────────────────────────────────────
  /** 输入时上报（2 秒节流；服务端还有 3 秒兜底节流）。 */
  const notifyTyping = useCallback(() => {
    const aid = activeRef.current;
    if (!aid) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    void api(`/api/chat/channels/${aid}/typing`, { method: 'POST' });
  }, []);

  // ── 回复 / 跳转原消息 ──────────────────────────────────────────────────
  // handleReply 必须是稳定引用：MessageItem 包了 memo，props 一变就白 memo 了。
  const handleReply = useCallback((m: ChatMessageDTO) => {
    setReplyTarget(m);
  }, []);

  const flashHighlight = useCallback((messageId: number) => {
    setHighlightId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), 2000);
  }, []);

  /** 跳到某条消息（点回复摘要 / 搜索结果）：在列表里就滚过去，不在就先补拉一页。 */
  const jumpToMessage = useCallback(
    (messageId: number) => {
      const find = () =>
        listRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      const hit = find();
      if (hit) {
        hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flashHighlight(messageId);
        return;
      }
      const aid = activeRef.current;
      if (!aid) return;
      void (async () => {
        const data = await api(`/api/chat/channels/${aid}/messages?before=${messageId + 1}`);
        if (data.code !== 200 || !Array.isArray(data.messages)) return;
        if (aid !== activeRef.current) return; // 拉取期间切了频道 → 放弃
        const older = data.messages as ChatMessageDTO[];
        if (!older.length) return;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !seen.has(m.id)), ...prev];
        });
        // 等这一帧渲染完再定位（否则节点还不存在）
        requestAnimationFrame(() => {
          find()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          flashHighlight(messageId);
        });
      })();
    },
    [flashHighlight]
  );

  // 跳转高亮的定时器在卸载时清掉，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    []
  );

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
                ? {
                    ...x,
                    is_deleted: true,
                    content: CHAT_DELETED_TEXT,
                    image: null,
                    image_missing: false,
                    blog: null,
                    blog_missing: false,
                  }
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

  // ── 会话偏好：静音 / 删除会话 ──────────────────────────────────────────
  const handleMute = useCallback(async (ch: ChatChannelDTO, muted: boolean) => {
    try {
      const data = await api(`/api/chat/channels/${ch.id}/mute`, {
        method: 'POST',
        body: JSON.stringify({ muted }),
      });
      if (data.code === 200) {
        setChannels((prev) => prev.map((c) => (c.id === ch.id ? { ...c, muted } : c)));
        toast(muted ? '已静音该会话' : '已取消静音', 'success');
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('网络错误，请重试', 'error');
    }
  }, []);

  const handleHide = useCallback(
    async (ch: ChatChannelDTO) => {
      if (!confirm(`删除与「${ch.title}」的会话？对方之后再发消息时它会重新出现。`)) return;
      try {
        const data = await api(`/api/chat/channels/${ch.id}/hide`, { method: 'POST' });
        if (data.code !== 200) {
          toast(data.message || '删除失败', 'error');
          return;
        }
        setChannels((prev) => prev.filter((c) => c.id !== ch.id));
        toast('会话已删除', 'success');
        // 删掉的正是当前打开的会话 → 切到第一个可用会话，没有就落空态
        if (activeRef.current === ch.id) {
          const next = channelsRef.current.find((c) => c.id !== ch.id && !c.disabled);
          if (next) {
            selectChannel(next.id);
          } else {
            setMessages([]);
            lastIdRef.current = 0;
            setActiveId(null);
            activeRef.current = null;
            viewTokenRef.current++;
            router.replace('/chat', { scroll: false });
          }
        }
      } catch {
        toast('网络错误，请重试', 'error');
      }
    },
    [router, selectChannel]
  );

  // ── 发起私聊（弹窗回调） ──────────────────────────────────────────────
  const onDirectCreated = useCallback(
    (ch: ChatChannelDTO) => {
      void switchWithFade(
        () => {
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
          stashDraft(activeRef.current);
          setActiveId(ch.id);
          activeRef.current = ch.id;
          setMessages([]);
          setReplyTarget(null);
          setPendingImage(null);
          setBlogQuote(null);
          setNewCount(0);
          setDrawerOpen(false);
          lastIdRef.current = 0;
          restoreDraft(ch.id);
          router.replace(`/chat?channel=${encodeURIComponent(ch.id)}`, { scroll: false });
        },
        () => {
          const token = ++viewTokenRef.current;
          return loadMessages(ch.id, token, true); // sync：同 selectChannel
        }
      );
    },
    [loadMessages, restoreDraft, router, stashDraft, switchWithFade]
  );

  return (
    <div className={`chat-page${sidebarCollapsed ? ' chat-page--collapsed' : ''}${drawerOpen ? ' chat-page--drawer-open' : ''}`}>
      <ChatSidebar
        channels={channels}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => {
          const next = !sidebarCollapsed;
          setSidebarCollapsed(next);
          persistCollapsed(next);
        }}
        onSelect={selectChannel}
        onNewChat={() => setModalOpen(true)}
        onMute={handleMute}
        onHide={handleHide}
      />

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
                <Menu />
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
              <span className="chat-main__spacer" />
              <SearchButton onClick={() => setSearchOpen(true)} />
              {activeChannel.kind === 'direct' && activeChannel.peer && (
                <Link className="chat-main__profile-link" href={`/u/${activeChannel.peer.id}`}>
                  个人资料 <ArrowRight aria-hidden="true" />
                </Link>
              )}
            </header>

            <div className="chat-list" ref={listRef}>
              {/* DOM 上限：超过 CAP 条时从顶部折叠（消息仍在内存里），
                  顶部按钮点一下往下放一页 —— 避免长会话把上万个节点堆在 DOM 里 */}
              {folded > 0 ? (
                <button
                  type="button"
                  className="chat-list__older"
                  onClick={() => setFoldedCount((c) => Math.max(0, c - REVEAL_STEP))}
                >
                  已折叠 {folded} 条 · 展开更早
                </button>
              ) : (
                hasMore &&
                messages.length > 0 && (
                  <button type="button" className="chat-list__older" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? '加载中…' : '加载更早的消息'}
                  </button>
                )
              )}
              {messages.length === 0 && (
                <div className="chat-list__empty">
                  {activeChannel.kind === 'lobby' ? '聊天大区空荡荡，说点什么吧' : '还没有消息，打个招呼吧'}
                </div>
              )}
              {visibleMessages.map((m, i, arr) => {
                const prev = i > 0 ? arr[i - 1] : null;
                const showDate = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                // 同人连续消息：5 分钟内、且两条都不是拍一拍/带引用 → 省略头像与名字
                const grouped =
                  !showDate &&
                  !!prev &&
                  prev.author.id === m.author.id &&
                  !m.reply &&
                  !m.pat &&
                  !prev.pat &&
                  minutesApart(prev.created_at, m.created_at) < GROUP_WINDOW_MIN;
                // 「以下是新消息」分隔线：进频道时的已读位置之后的第一条
                const showNewSep =
                  newCount > 0 &&
                  unreadAnchorRef.current > 0 &&
                  m.id > unreadAnchorRef.current &&
                  (!prev || prev.id <= unreadAnchorRef.current);
                return (
                  <Fragment key={m.id}>
                    {showDate && (
                      <div className="chat-date-sep">
                        <span>{fmtDay(m.created_at)}</span>
                      </div>
                    )}
                    {showNewSep && <div className="chat-list__new-sep">以下是新消息</div>}
                    <ChatMessageItem
                      msg={m}
                      isMine={m.author.id === currentUserId}
                      canDelete={m.author.id === currentUserId || isAdmin}
                      currentUserId={currentUserId}
                      currentUsername={currentUsername}
                      highlighted={highlightId === m.id}
                      grouped={grouped}
                      receipt={
                        m.id === lastMineId && activeChannel.kind === 'direct'
                          ? peerLastRead >= m.id
                            ? 'read'
                            : 'unread'
                          : null
                      }
                      onReply={handleReply}
                      onDelete={handleDelete}
                      onAvatarClick={openAvatarMenu}
                      onJumpToReply={jumpToMessage}
                    />
                  </Fragment>
                );
              })}
            </div>

            {typingNames.length > 0 && (
              <div className="chat-typing" aria-live="polite">
                {activeChannel.kind === 'direct'
                  ? '对方正在输入…'
                  : typingNames.length === 1
                    ? `${typingNames[0]} 正在输入…`
                    : `${typingNames.length} 人正在输入…`}
              </div>
            )}

            {newCount > 0 && (
              <button type="button" className="chat-jump-new" onClick={() => {
                scrollToBottom('smooth');
                if (lastIdRef.current) void markRead(activeRef.current!, lastIdRef.current);
                setNewCount(0);
              }}>
                {newCount} 条新消息 <ArrowDown aria-hidden="true" />
              </button>
            )}

            <ChatComposer
              activeId={activeId}
              text={text}
              sending={sending}
              pendingImage={pendingImage}
              uploadingImage={uploadingImage}
              replyTarget={replyTarget}
              blogQuote={blogQuote}
              textareaRef={textareaRef}
              fileRef={fileRef}
              onTextChange={(v) => {
                setText(v);
                if (v) notifyTyping();
              }}
              onSend={() => void send()}
              onPickImage={(f) => void pickImage(f)}
              onOpenQuote={() => setQuoteOpen(true)}
              onClearReply={() => setReplyTarget(null)}
              onClearBlogQuote={() => setBlogQuote(null)}
              onClearImage={() => setPendingImage(null)}
            />
          </>
        ) : (
          <div className="chat-main__empty">
            {channelsLoaded && initialFocusMode ? (
              <>
                已开启专注模式，聊天大区暂不可用。可发起私聊，或{' '}
                <Link className="chat-main__focus-link" href="/settings#focus-mode">
                  前往设置
                </Link>{' '}
                关闭专注模式。
              </>
            ) : (
              '加载中…'
            )}
          </div>
        )}
      </main>

      {modalOpen && (
        <NewChatModal
          onClose={() => setModalOpen(false)}
          onCreated={onDirectCreated}
          currentUserId={currentUserId}
        />
      )}

      {searchOpen && activeChannel && (
        <ChatSearchModal
          channelId={activeChannel.id}
          channelTitle={activeChannel.kind === 'lobby' ? CHAT_LOBBY_TITLE : activeChannel.title}
          onClose={() => setSearchOpen(false)}
          onJump={jumpToMessage}
        />
      )}

      {quoteOpen && (
        <QuoteBlogModal
          onClose={() => setQuoteOpen(false)}
          onPick={(b) => {
            // 单附件：再选即替换
            setBlogQuote(b);
            setQuoteOpen(false);
          }}
        />
      )}

      {avatarMenu && (
        <AvatarMenu
          target={avatarMenu.author}
          anchor={avatarMenu.anchor}
          onClose={() => setAvatarMenu(null)}
          onPat={() => {
            const target = avatarMenu.author;
            setAvatarMenu(null);
            void sendPat(target);
          }}
          onMention={() => {
            const target = avatarMenu.author;
            setAvatarMenu(null);
            insertMention(target.username);
          }}
        />
      )}
    </div>
  );
}