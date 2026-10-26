// ─────────────────────────────────────────────────────────────────────────────
// site-embed-static.tsx — `site-embed` 宿主组件的**只读渲染器**（无 hooks、无 DOM）
//
// 这份文件同时被两处使用：
//   · `SiteEmbedView`（客户端）在 static / 预览态直接调用它；
//   · 阅读页的 `reactive-static`（同版本快照或本次现编译）也走它。
// 所以这里只允许纯数据与 React 元素：不 import 客户端模块、不读 window、不发请求。
//
// 类名沿用站内既有嵌入件的成品形态（`.vote-embed*` / `.favorite-embed*`），
// 这样现有 SCSS 与 e2e 选择器不用为「换了个渲染器」改一遍。所有动态文本都由
// React 转义；链接目标**只**由校验过的 kind/ref 拼出来，绝不采信 payload 里的
// href —— 那会让一份伪造的 hostData 变成 `javascript:` 链接。
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import type { LocalNode } from 'reactive-md';
import type { LocalRenderContext } from 'reactive-md/react';
import type { SiteEmbedData, SiteEmbedKind } from '@/lib/reactive/ref-types';
import { CONTENT_FORMAT_LABELS, parseContentFormat } from '@/lib/content-format';
import { MAX_CARD_ITEMS } from '@/lib/favorite-refs';
import type { VoteEmbedData, VoteOptionData } from '@/lib/blog-markdown';

/** 与宿主 schema 的 pattern 一致（计划 D1）：只允许短字母数字 id。 */
const SAFE_REF = /^[A-Za-z0-9]{1,32}$/;

/** 各类引用自己的真实形态。比对失败就落错误占位，绝不拿它拼 URL。 */
const KIND_REF: Record<SiteEmbedKind, RegExp> = {
  audio: /^[A-Za-z0-9]{10}$/,
  vote: /^[A-Za-z0-9]{1,32}$/,
  favorite: /^[0-9]{6}$/,
  clipboard: /^[A-Za-z0-9]{8}$/,
};

/** 收藏夹条目的博客 id 只作为站内路径的一段；UUID 以外的值不给链接。 */
const SAFE_BLOG_ID = /^[A-Za-z0-9-]{1,64}$/;

const EMBED_KINDS: readonly SiteEmbedKind[] = ['audio', 'vote', 'favorite', 'clipboard'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSiteEmbedKind(value: unknown): value is SiteEmbedKind {
  return typeof value === 'string' && (EMBED_KINDS as readonly string[]).includes(value);
}

export type SiteEmbedResolution =
  | { status: 'ready'; kind: SiteEmbedKind; ref: string; data: SiteEmbedData }
  | { status: 'error' | 'forbidden'; kind: SiteEmbedKind | null; ref: string | null };

/**
 * 把节点属性与 hostData 对齐。
 *
 * 两种不一致都按 error 处理：作者伪造了标签、或服务端发了标签却没给数据。
 * 后者在 ReactiveMD 里本来会显示 `local-host-unavailable` 占位；我们自己的
 * 占位文案更明确，也不会把半个组件渲染出来。
 */
export function resolveSiteEmbed(node: LocalNode, data: unknown): SiteEmbedResolution {
  const attrKind = node.attrs?.kind;
  const attrRef = node.attrs?.ref;
  if (
    !isSiteEmbedKind(attrKind) ||
    typeof attrRef !== 'string' ||
    !SAFE_REF.test(attrRef) ||
    !KIND_REF[attrKind].test(attrRef)
  ) {
    return { status: 'error', kind: null, ref: null };
  }

  if (!isRecord(data) || data.kind !== attrKind || data.ref !== attrRef) {
    return { status: 'error', kind: attrKind, ref: attrRef };
  }

  if (data.status === 'forbidden') return { status: 'forbidden', kind: attrKind, ref: attrRef };
  if (data.status !== 'ready') return { status: 'error', kind: attrKind, ref: attrRef };

  return {
    status: 'ready',
    kind: attrKind,
    ref: attrRef,
    data: data as unknown as SiteEmbedData,
  };
}

/** 三态里的失败态：一个可见、可屏读的说明，不带任何链接。 */
export function SiteEmbedStatus({ status }: { status: 'error' | 'forbidden' }): ReactNode {
  const failed = status === 'error';
  return (
    <div
      className={
        failed
          ? 'site-embed__status site-embed__status--error'
          : 'site-embed__status site-embed__status--forbidden'
      }
      role="status"
    >
      {failed ? '内容加载失败' : '无权查看此内容'}
    </div>
  );
}

export interface VoteWidgetProps {
  voteId: string;
  data: VoteEmbedData;
  interactive: boolean;
  selected?: number | null;
  busy?: boolean;
  error?: string | null;
  onSelect?: (optionId: number) => void;
  onSubmit?: () => void;
}

/** 可投票 = 未锁定且本人未投过（与 blog-markdown.ts 的 canVote 同口径）。 */
function canVote(data: VoteEmbedData): boolean {
  return !data.is_locked && data.user_voted == null;
}

/**
 * 投票小组件的共用标记。交互与只读走同一份结构，只是控件是否禁用、
 * 是否挂处理器不同 —— 别为预览另抄一份，否则两种形态会慢慢漂开。
 */
export function VoteWidget({
  voteId,
  data,
  interactive,
  selected = null,
  busy = false,
  error = null,
  onSelect,
  onSubmit,
}: VoteWidgetProps): ReactNode {
  const votable = canVote(data);

  return (
    <div className="vote-embed">
      <div className="vote-embed-widget">
        <div className="vote-embed-title">{data.title}</div>

        {data.is_locked ? <span className="vote-embed-badge badge-locked">已锁定</span> : null}

        {!votable ? <p className="vote-embed-total">共 {data.total_votes} 票</p> : null}

        {data.options.map((option) =>
          votable ? (
            <button
              key={option.id}
              type="button"
              className={
                selected === option.id
                  ? 'vote-embed-option vote-embed-option--selected'
                  : 'vote-embed-option'
              }
              data-option-id={String(option.id)}
              disabled={!interactive || busy}
              onClick={interactive && onSelect ? () => onSelect(option.id) : undefined}
            >
              <div className="vote-embed-option-content">
                <span className="vote-embed-option-label">{option.label}</span>
              </div>
            </button>
          ) : (
            <div
              key={option.id}
              className={
                data.user_voted === option.id
                  ? 'vote-embed-option vote-embed-option--result vote-embed-option--voted'
                  : 'vote-embed-option vote-embed-option--result'
              }
            >
              <div className="vote-embed-bar" style={{ width: `${option.percentage}%` }} />
              <div className="vote-embed-option-content">
                <span className="vote-embed-option-label">{option.label}</span>
                <span className="vote-embed-option-stats">
                  {option.count} 票 · {option.percentage}%
                </span>
              </div>
            </div>
          )
        )}

        {votable ? (
          <button
            type="button"
            className="vote-embed-submit"
            disabled={!interactive || selected == null || busy}
            onClick={interactive && onSubmit ? onSubmit : undefined}
          >
            {busy ? '投票中……' : '投票'}
          </button>
        ) : null}

        {error ? (
          <p className="site-embed__status site-embed__status--error" role="alert">
            {error}
          </p>
        ) : null}

        <a className="vote-embed-link" href={`/vote/${voteId}`} target="_blank" rel="noopener">
          查看详情
        </a>
      </div>
    </div>
  );
}

function isVoteOption(value: unknown): value is VoteOptionData {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isFinite(value.id) &&
    typeof value.label === 'string' &&
    typeof value.count === 'number' &&
    Number.isFinite(value.count) &&
    typeof value.percentage === 'number' &&
    Number.isFinite(value.percentage)
  );
}

/** hostData 是 JSON-safe 的 `unknown`；字段形状不对就不渲染半个组件。 */
export function parseVoteData(payload: unknown): VoteEmbedData | null {
  if (!isRecord(payload)) return null;
  const { title, is_locked, total_votes, user_voted, options } = payload;
  if (
    typeof title !== 'string' ||
    typeof is_locked !== 'boolean' ||
    typeof total_votes !== 'number' ||
    !Number.isFinite(total_votes) ||
    !(user_voted === null || (typeof user_voted === 'number' && Number.isFinite(user_voted))) ||
    !Array.isArray(options) ||
    !options.every(isVoteOption)
  ) {
    return null;
  }
  return { title, is_locked, total_votes, user_voted, options };
}

interface FavoriteItem {
  blogId: string;
  title: string;
}

function parseFavoritePayload(payload: unknown): {
  title: string;
  authorName: string;
  count: number;
  items: FavoriteItem[];
} | null {
  if (!isRecord(payload) || typeof payload.title !== 'string') return null;
  const authorName = typeof payload.authorName === 'string' ? payload.authorName : '';
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: FavoriteItem[] = [];
  for (const raw of rawItems.slice(0, MAX_CARD_ITEMS)) {
    if (!isRecord(raw) || typeof raw.blogId !== 'string' || typeof raw.title !== 'string') continue;
    items.push({ blogId: raw.blogId, title: raw.title });
  }
  const count =
    typeof payload.count === 'number' && Number.isFinite(payload.count)
      ? payload.count
      : items.length;
  return { title: payload.title, authorName, count, items };
}

function AudioEmbed({ audioId }: { audioId: string }): ReactNode {
  return (
    <audio
      className="site-embed site-embed--audio"
      controls
      preload="none"
      src={`/api/audio/${audioId}/raw`}
    />
  );
}

function FavoriteEmbed({
  favoriteId,
  data,
}: {
  favoriteId: string;
  data: SiteEmbedData;
}): ReactNode {
  const payload = parseFavoritePayload(data.payload);
  if (!payload) return <SiteEmbedStatus status="error" />;

  return (
    <div className="favorite-embed">
      <div className="favorite-embed__head">
        <span className="favorite-embed__title">{payload.title}</span>
        <span className="favorite-embed__count">共 {payload.count} 篇</span>
        {payload.authorName ? (
          <span className="favorite-embed__author">@{payload.authorName}</span>
        ) : null}
      </div>

      {payload.items.length ? (
        <ul className="favorite-embed__list">
          {payload.items.map((item, index) =>
            SAFE_BLOG_ID.test(item.blogId) ? (
              <li key={`${item.blogId}-${index}`}>
                <a className="favorite-embed__item" href={`/blog/${item.blogId}`}>
                  {item.title}
                </a>
              </li>
            ) : (
              <li key={`item-${index}`}>
                <span className="favorite-embed__item">{item.title}</span>
              </li>
            )
          )}
        </ul>
      ) : null}

      {payload.count > payload.items.length ? (
        <a className="favorite-embed__more" href={`/favorite/${favoriteId}`}>
          查看全部 {payload.count} 篇 →
        </a>
      ) : null}
    </div>
  );
}

/** 剪贴板首期一律是链接卡片：**绝不渲染 content**，也不嵌套编译。 */
function ClipboardEmbed({
  clipboardId,
  data,
}: {
  clipboardId: string;
  data: SiteEmbedData;
}): ReactNode {
  const title =
    typeof data.title === 'string' && data.title.length > 0
      ? data.title
      : `剪贴板 ${clipboardId}`;
  const format = parseContentFormat(data.format);

  return (
    <a className="site-embed-clipboard" href={`/clipboard/${clipboardId}`}>
      <span className="site-embed-clipboard__title">{title}</span>
      <span className="site-embed-clipboard__meta">
        {format ? (
          <span className="site-embed-clipboard__format">{CONTENT_FORMAT_LABELS[format]}</span>
        ) : null}
        <span>剪贴板</span>
      </span>
    </a>
  );
}

/**
 * 服务端快照 / 静态与预览态的唯一入口。
 *
 * `ctx` 只为签名对齐：静态形态不读 runtime、不挂事件、不发请求。
 */
export function renderSiteEmbedStatic(
  node: LocalNode,
  data: unknown,
  ctx: LocalRenderContext
): ReactNode {
  void ctx;
  const resolved = resolveSiteEmbed(node, data);
  if (resolved.status !== 'ready') return <SiteEmbedStatus status={resolved.status} />;

  switch (resolved.kind) {
    case 'audio':
      return <AudioEmbed audioId={resolved.ref} />;
    case 'clipboard':
      return <ClipboardEmbed clipboardId={resolved.ref} data={resolved.data} />;
    case 'favorite':
      return <FavoriteEmbed favoriteId={resolved.ref} data={resolved.data} />;
    case 'vote': {
      const vote = parseVoteData(resolved.data.payload);
      if (!vote) return <SiteEmbedStatus status="error" />;
      return <VoteWidget voteId={resolved.ref} data={vote} interactive={false} />;
    }
    default:
      return <SiteEmbedStatus status="error" />;
  }
}
