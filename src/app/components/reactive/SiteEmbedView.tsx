'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SiteEmbedView.tsx — `site-embed` 宿主组件的**交互渲染器**
//
// 只做一件事：把已经校验过的投票数据接到现有投票接口上。其余三类引用、以及
// static / 预览态，全部委托给 `site-embed-static.tsx` —— 同一份标记、同一批类名，
// 不维护第二套静态组件。
//
// 两条不能破的纪律：
//   · **绝不 `dangerouslySetInnerHTML`**：标题、选项、用户名都是用户输入；
//   · **链接只由 kind/ref 拼**：hostData 里的 href 一律不采信，否则一份伪造数据
//     就能把 `javascript:` 塞进正文。
// ─────────────────────────────────────────────────────────────────────────────

import { useState, type ReactNode } from 'react';
import type { LocalNode } from 'reactive-md';
import type { LocalRenderContext } from 'reactive-md/react';
import {
  parseVoteData,
  renderSiteEmbedStatic,
  resolveSiteEmbed,
  VoteWidget,
} from './site-embed-static';
import type { VoteEmbedData } from '@/lib/blog-markdown';

export interface SiteEmbedViewOptions {
  /** 编辑器预览：看得见、点不动，不发任何业务写请求。 */
  preview?: boolean;
}

interface InteractiveVoteProps {
  voteId: string;
  initial: VoteEmbedData;
}

/** 交互投票：POST 形状与 `src/lib/blog-markdown.ts` 的 attachVoteHandlers 逐字一致。 */
function InteractiveVote({ voteId, initial }: InteractiveVoteProps): ReactNode {
  const [data, setData] = useState<VoteEmbedData>(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (selected == null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/votes/${voteId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ optionId: selected }),
      });
      const result = (await res.json()) as { code?: number; message?: string };
      if (result.code !== 200) {
        setError(`投票失败：${result.message || '未知错误'}`);
        return;
      }

      // 票数与百分比以服务端为准：重新拉一次结果，不做本地乐观累加。
      const refreshed = await fetch(`/api/votes/${voteId}`, { credentials: 'same-origin' });
      const json = (await refreshed.json()) as { code?: number; data?: unknown };
      const next = json.code === 200 ? parseVoteData(json.data) : null;
      if (!next) {
        setError('投票已提交，但结果加载失败');
        return;
      }
      setData(next);
      setSelected(null);
    } catch {
      setError('出错了，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <VoteWidget
      voteId={voteId}
      data={data}
      interactive
      selected={selected}
      busy={busy}
      error={error}
      onSelect={setSelected}
      onSubmit={() => void submit()}
    />
  );
}

/**
 * 宿主渲染入口。签名保持「位置参数」是因为它由 `hostRenderer` 直接调用；
 * 本函数自身不持有 hooks，交互态在 `<InteractiveVote>` 里 —— 直接调用也安全。
 */
export function SiteEmbedView(
  node: LocalNode,
  data: unknown,
  ctx: LocalRenderContext,
  options?: SiteEmbedViewOptions
): ReactNode {
  // 预览与静态快照一律只读：不挂处理器、不发请求。
  if (ctx.mode === 'static' || options?.preview) {
    return renderSiteEmbedStatic(node, data, ctx);
  }

  const resolved = resolveSiteEmbed(node, data);
  if (resolved.status !== 'ready' || resolved.kind !== 'vote') {
    return renderSiteEmbedStatic(node, data, ctx);
  }

  const vote = parseVoteData(resolved.data.payload);
  if (!vote) return renderSiteEmbedStatic(node, data, ctx);

  return <InteractiveVote voteId={resolved.ref} initial={vote} />;
}
