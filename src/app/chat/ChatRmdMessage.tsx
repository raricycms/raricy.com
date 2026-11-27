'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdMessage.tsx — 聊天消息正文的 ReactiveMD 视图
//
// 一条消息的生命周期：
//   源码 → ChatCompileManager 订阅（key / revision 单调）→ 编译文档
//   → final 阶段再做一次引用适配（hostData 按 slot 落位）→ LocalStaticDocumentView
//   → ChatRmdHostView 渲染受控媒体
//
// 关键纪律：
//   · 旧 revision 的结果一律丢弃；订阅在换 key / 卸载时撤销。
//   · final 文档提交走 startTransition（快速滚动 / 流式更新期间让出主线程），
//     streaming 保持紧急更新以跟上生成节奏。
//   · 编译失败 / 超预算 / Worker 不可用 / 无 provider 时显示**完整源码**（React
//     文本节点，根类名 `chat-msg__md--source`），绝不让正文消失。
//   · streaming 阶段不请求任何引用与媒体：hostData 为空、URL 策略全部拒绝。
//   · final 适配失败只保留文字 token，正文继续用未适配文档。
//   · 裸图类 `chat-msg__md--single-image` 由适配器的候选 slot + DTO 的
//     allowBareImage + 该 slot 的媒体失败状态共同决定；streaming 一律不加。
//   · 整条正文只有一张内置黄脸时由最终适配文档 + 可见节点计算 `rich-emoji-solo`，
//     不靠正则猜源码。
// ─────────────────────────────────────────────────────────────────────────────

import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LocalDocument } from 'reactive-md';
import type { LocalHostData, LocalHostRenderer, LocalUrlPolicy } from 'reactive-md/react';
import { chatReactiveUrlPolicy } from '@/lib/chat-rmd/options';
import { adaptChatReferences } from '@/lib/chat-rmd/references';
import {
  CHAT_REF_HOST_TAG,
  CHAT_REF_SLOT_ATTR,
  CHAT_REFERENCE_BUDGET,
  isChatHostData,
} from '@/lib/chat-rmd/reference-types';
import type {
  ChatCompiledSnapshot,
  ChatReferenceContext,
  ChatReferenceDocument,
  ChatSourcePhase,
} from '@/lib/chat-rmd/types';
import ChatRmdDocument from './ChatRmdDocument';
import { ChatRmdHostView, type ChatRmdHostEnvironment } from './ChatRmdHostView';
import { useChatRmd } from './ChatRmdProvider';

/** 离屏预取带：进入这个范围外先不编译（设计 §3.2）。 */
const CHAT_RMD_PREFETCH_PX = 800;

const EMPTY_SLOTS: ReadonlySet<string> = new Set<string>();
const EMPTY_HOST_DATA: LocalHostData = Object.freeze({});

/** 服务端渲染时 useLayoutEffect 会触发 React 警告；改用无副作用的 useEffect。 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** streaming 阶段（或 final 结果尚未到手时）的 URL 策略：链接与图片全部拒绝。 */
const DENY_ALL_URL_POLICY: LocalUrlPolicy = () => false;

interface CompiledState {
  revision: number;
  phase: ChatSourcePhase;
  document: LocalDocument | null;
}

/** 适配结果与它对应的编译 revision 绑定；不同 revision 的 hostData 绝不混用。 */
interface AdaptedState {
  revision: number;
  reference: ChatReferenceDocument;
}

export interface ChatRmdMessageProps {
  /** 稳定身份：正式消息 `msg:<id>`，临时预览 `gen:<id>`。 */
  messageKey: string;
  content: string;
  phase: ChatSourcePhase;
  /** 由消息附件 DTO 决定；false 时不加裸图类。 */
  allowBareImage?: boolean;
  onImageClick?: (url: string) => void;
  /** 编译提交 / 引用落位 / 媒体 load-error 后通知宿主重新跟随滚动。 */
  onContentChange?: () => void;
  /**
   * 即将改变正文高度的状态提交**之前**回调（编译文档、引用落位、媒体落位）。
   * 宿主在这里记录「变化前是否贴底」—— 变化后再量，一次增高超过阈值就会被误判
   * 成离底，原本贴底的用户会中断跟随（见 ChatApp 的 handleContentBeforeChange）。
   */
  onBeforeContentChange?: () => void;
  className?: string;
}

/**
 * 整条正文恰好只有一张内置黄脸时返回它的 slot。
 *
 * 判据来自**最终适配文档的可见结构**（不是源码正则）：唯一一个段落，段内只有
 * 空白文本与一个 emoji 宿主节点；媒体已失败或其他元素/非空文本都出局。
 * 与旧 `markSoloEmojiFaces` 的「只有一层 P 包着唯一表情图」同口径，但不必扫描 DOM。
 */
function findSoloEmojiSlot(
  reference: ChatReferenceDocument,
  failedSlots: ReadonlySet<string>
): string | null {
  const nodes = reference.document.nodes;
  if (nodes.length !== 1) return null;
  const paragraph = nodes[0];
  if (paragraph.type !== 'paragraph' || !paragraph.children?.length) return null;

  let slot: string | null = null;
  for (const child of paragraph.children) {
    if (child.type === 'text') {
      if ((child.value ?? '').trim() !== '') return null;
      continue;
    }
    if (child.type !== 'hostComponent' || child.name !== CHAT_REF_HOST_TAG) return null;
    if (slot !== null) return null;
    const childSlot = child.attrs?.[CHAT_REF_SLOT_ATTR];
    if (typeof childSlot !== 'string') return null;
    const data = reference.hostData[childSlot];
    if (!isChatHostData(data) || data.slot !== childSlot) return null;
    if (data.kind !== 'sticker' || !data.emoji) return null;
    if (failedSlots.has(childSlot)) return null;
    slot = childSlot;
  }
  return slot;
}

function classNames(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(' ');
}

export default function ChatRmdMessage({
  messageKey,
  content,
  phase,
  allowBareImage = true,
  onImageClick,
  onContentChange,
  onBeforeContentChange,
  className,
}: ChatRmdMessageProps) {
  const context = useChatRmd();
  const manager = context?.manager ?? null;
  const contentEmpty = content.trim() === '';

  const [compiled, setCompiled] = useState<CompiledState | null>(null);
  const [adaptedState, setAdaptedState] = useState<AdaptedState | null>(null);
  const [failedSlots, setFailedSlots] = useState<ReadonlySet<string>>(EMPTY_SLOTS);
  const [mediaEpoch, setMediaEpoch] = useState(0);
  /** near = 已进入预取带（要编译）；far = 离屏（先显示源码，进入再排队）。 */
  const [compileRange, setCompileRange] = useState<'unknown' | 'near' | 'far'>('unknown');

  const revisionRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 进入预取带时的优先级：视口内 visible，视口外的预取带 nearby。 */
  const compilePriorityRef = useRef<'visible' | 'nearby'>('visible');
  /**
   * 变化前通知的 ref 镜像：回调可能每秒换引用（快照流式更新），而这里要把它
   * 带进订阅 / 适配 effect 的闭包又不让它们重跑，所以统一经 ref 读最新值。
   */
  const notifyBeforeRef = useRef(onBeforeContentChange);

  // 换 key / 换 manager：上一份编译与适配结果不再属于这条消息。
  useEffect(() => {
    setCompiled(null);
    setAdaptedState(null);
    setFailedSlots(EMPTY_SLOTS);
  }, [manager, messageKey]);

  // 只有**文档本身**变化时才给逐槽媒体一次重试机会；同一份文档被重复回传
  // （缓存命中 / 重新订阅）不重置，避免失败媒体「重载 → 再失败 → 重置」的回路。
  const compiledDocument = compiled?.document ?? null;
  useEffect(() => {
    setFailedSlots((previous) => (previous.size === 0 ? previous : EMPTY_SLOTS));
  }, [compiledDocument, messageKey]);

  /**
   * 离屏消息不排队（设计 §3.2 初始策略）：最多 300 条 DOM 全量编一次会把共享
   * Worker 的队列塞满，流式最新快照要排在几百条历史之后。viewport 内的正式消息
   * 优先，预取带内用 nearby，真正离屏先显示源码；滚动进入后再订阅。
   *
   * 用 layout effect 先量一次，避免首帧把所有消息都当 visible 提交；浏览器
   * 不支持 IntersectionObserver（测试 / 旧环境）时回退为「全部立即编译」。
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined') {
      compilePriorityRef.current = 'visible';
      setCompileRange('near');
      return;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const measure = (rect: Pick<DOMRectReadOnly, 'top' | 'bottom'>): void => {
      const inViewport = rect.bottom >= 0 && rect.top <= viewportHeight;
      compilePriorityRef.current = inViewport ? 'visible' : 'nearby';
      const near =
        rect.bottom >= -CHAT_RMD_PREFETCH_PX && rect.top <= viewportHeight + CHAT_RMD_PREFETCH_PX;
      setCompileRange(near ? 'near' : 'far');
    };

    measure(root.getBoundingClientRect());
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // isIntersecting 只表示进入 rootMargin（预取带），是否真在视口内还要看矩形。
        if (!entry.isIntersecting) {
          setCompileRange('far');
          return;
        }
        measure(entry.boundingClientRect);
      },
      { root: null, rootMargin: `${CHAT_RMD_PREFETCH_PX}px 0px` }
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [messageKey]);

  // 订阅编译结果：content / phase / key 任一变化都产生新 revision。
  useEffect(() => {
    if (!manager || contentEmpty || compileRange !== 'near') return;

    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    let active = true;
    let unsubscribe: (() => void) | null = null;

    const receive = (snapshot: ChatCompiledSnapshot): void => {
      if (!active) return;
      if (snapshot.key !== messageKey) return;
      if (snapshot.revision !== revision || snapshot.phase !== phase) return;
      // 同一份文档被重复回传（典型：离屏 → 视口内重新订阅命中 final 缓存）时
      // 不产生新状态：否则 onContentChange / 引用适配 / 失败槽重置都会被重新触发，
      // 与滚动触发的 IntersectionObserver 订阅切换叠在一起会形成回路。
      // 变化前通知放在 updater 外面：即使随后因同文档幂等跳过也是无害的空记录，
      // 而放进 updater 会在 StrictMode 下被重复调用、也不能保证早于提交。
      notifyBeforeRef.current?.();
      const commit = (): void => {
        setCompiled((previous) => {
          if (
            previous &&
            previous.phase === snapshot.phase &&
            previous.document === snapshot.document
          ) {
            return previous;
          }
          return { revision, phase: snapshot.phase, document: snapshot.document };
        });
      };
      // final 文档是整条消息最大的一次提交（后续还跟着引用适配）；放进 transition，
      // 快速滚动时不与滚动 / 流式更新争抢同步渲染。streaming 仍需紧急更新。
      if (snapshot.phase === 'final') {
        startTransition(commit);
      } else {
        commit();
      }
    };

    try {
      unsubscribe = manager.subscribe(
        { key: messageKey, revision, source: content, phase, priority: compilePriorityRef.current },
        receive
      );
    } catch {
      // Worker 不可用时保持源码显示；下一次 effect 会再试。
      unsubscribe = null;
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [manager, messageKey, content, phase, contentEmpty, compileRange]);

  // final 编译成功后才做引用适配；取消旧适配，卸载时中止。
  useEffect(() => {
    if (
      phase !== 'final' ||
      !context ||
      !compiled ||
      compiled.phase !== 'final' ||
      !compiled.document
    ) {
      setAdaptedState(null);
      return;
    }

    const controller = new AbortController();
    const referenceContext: ChatReferenceContext = {
      viewerScope: context.viewerScope,
      signal: controller.signal,
      compileChild: context.compileChild,
      budget: CHAT_REFERENCE_BUDGET,
      depth: 0,
    };

    void adaptChatReferences(compiled.document, referenceContext)
      .then((reference) => {
        if (controller.signal.aborted) return;
        if (
          !reference ||
          !Array.isArray(reference.document?.nodes) ||
          typeof reference.hostData !== 'object' ||
          reference.hostData === null
        ) {
          return;
        }
        // 引用落位会一次性把 token 换成媒体、改变高度：提交前先让宿主记录位置。
        notifyBeforeRef.current?.();
        setFailedSlots((previous) => (previous.size === 0 ? previous : EMPTY_SLOTS));
        setAdaptedState({ revision: compiled.revision, reference });
      })
      .catch(() => {
        // 引用失败只让 token 保持文字；未适配文档继续显示。
      });

    return () => controller.abort();
  }, [phase, context, compiled]);

  const activeReference =
    phase === 'final' &&
    compiled?.phase === 'final' &&
    adaptedState !== null &&
    adaptedState.revision === compiled.revision
      ? adaptedState.reference
      : null;

  const viewDocument = activeReference?.document ?? compiled?.document ?? null;
  const hostData: LocalHostData = activeReference?.hostData ?? EMPTY_HOST_DATA;

  /**
   * 外链加固：上游只加 `_blank` + noopener noreferrer，聊天设计还要求 nofollow。
   * URL 策略只管协议/地址，管不到 rel；在文档提交后补一次属性（不改节点与内容）。
   * 站内链接保持当前页导航，只有 http(s) 外链开新标签。
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      anchor.rel = 'noopener noreferrer nofollow';
      const href = anchor.getAttribute('href') ?? '';
      if (/^https?:/i.test(href)) anchor.target = '_blank';
      // 旧聊天正文给链接的是 .chat-msg__link（e2e 与气泡样式都认它）；RMD 自己
      // 不产出类名，这里补上。名片/剪贴板回链有各自的成品外观，不叠加。
      if (
        !anchor.classList.contains('rich-user-ref') &&
        !anchor.classList.contains('chat-rmd-clipboard-link')
      ) {
        anchor.classList.add('chat-msg__link');
      }
    }
  }, [viewDocument, phase]);

  const denyUrls =
    phase === 'streaming' ||
    (phase === 'final' && compiled?.phase === 'streaming') ||
    !compiled;
  const activeUrlPolicy: LocalUrlPolicy = denyUrls ? DENY_ALL_URL_POLICY : chatReactiveUrlPolicy;

  const soloEmojiSlot = useMemo(
    () => (activeReference ? findSoloEmojiSlot(activeReference, failedSlots) : null),
    [activeReference, failedSlots]
  );

  const handleMediaSettled = useCallback((slot: string, failed: boolean): void => {
    if (!slot) return;
    // 只在失败时记录「变化前」：成功 load 发生在浏览器应用图片尺寸之后，此时再量
    // 已经是变化后的位置，会覆盖引用落位前记录的正确快照。成功的增高沿用
    // setAdaptedState / setCompiled 之前那次 before；用户在等待加载期间滚开的情况
    // 由 ChatApp 的用户滚动同步窗修正。
    if (failed) notifyBeforeRef.current?.();
    setMediaEpoch((epoch) => epoch + 1);
    if (!failed) return;
    setFailedSlots((previous) => {
      if (previous.has(slot)) return previous;
      const next = new Set(previous);
      next.add(slot);
      return next;
    });
  }, []);

  const hostEnvironment = useMemo<ChatRmdHostEnvironment>(
    () => ({
      hostData,
      failedSlots,
      soloEmojiSlot,
      allowClipboard: true,
      urlPolicy: activeUrlPolicy,
      onImageClick,
      onMediaSettled: handleMediaSettled,
    }),
    [hostData, failedSlots, soloEmojiSlot, activeUrlPolicy, onImageClick, handleMediaSettled]
  );

  const hostRenderer = useCallback<LocalHostRenderer>(
    (node, data, renderContext) => ChatRmdHostView(node, data, renderContext, hostEnvironment),
    [hostEnvironment]
  );

  const bareImageSlot = activeReference?.bareImageCandidateSlot ?? null;
  const singleImage =
    phase === 'final' &&
    compiled?.phase === 'final' &&
    viewDocument !== null &&
    allowBareImage !== false &&
    // 单发内置黄脸与单图共用气泡零内距（旧 RichContentBody 把 solo 表情也算作
    // 「唯一图片」）；它的尺寸仍由 rich-emoji-solo 决定。
    ((bareImageSlot !== null && !failedSlots.has(bareImageSlot)) || soloEmojiSlot !== null);

  const notifyRef = useRef(onContentChange);
  useIsomorphicLayoutEffect(() => {
    notifyRef.current = onContentChange;
    notifyBeforeRef.current = onBeforeContentChange;
  });

  // 编译提交、引用落位、媒体 load/error 后合并到一次 layout effect 通知宿主。
  useIsomorphicLayoutEffect(() => {
    if (contentEmpty) return;
    notifyRef.current?.();
  }, [compiled, activeReference, mediaEpoch, singleImage, soloEmojiSlot, contentEmpty]);

  if (contentEmpty) return null;

  const sourceMode = !viewDocument;
  const rootClassName = classNames(
    'chat-msg__md',
    sourceMode && 'chat-msg__md--source',
    singleImage && 'chat-msg__md--single-image',
    className
  );

  return (
    <div ref={rootRef} className={rootClassName}>
      {viewDocument ? (
        <ChatRmdDocument
          document={viewDocument}
          hostData={hostData}
          hostRenderer={hostRenderer}
          urlPolicy={activeUrlPolicy}
        />
      ) : (
        content
      )}
    </div>
  );
}

export { ChatRmdMessage };