'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CommentMarkdown.tsx — 评论正文的 Markdown 渲染壳
//
// 与 ChatMarkdown.tsx 同构。真正干活的是 @/lib/comment-markdown
// （marked → DOMPurify → 后处理），这里只负责：
//   · memo：内容不变就跳过重渲染。评论区任何一次「回复 / 删除 / 点赞」都会让整棵树
//     重渲染，而树可能有上百条 —— 少了这层，每敲一个字都在重跑整棵树的净化管线；
//   · useMemo：同一条评论的重渲染不重复跑管线（模块内还有一层 FIFO 缓存兜底）。
//
// 【水合说明】renderCommentMarkdown 在无 DOM 环境返回转义纯文本，客户端返回净化后的
// HTML —— 两者不同，但**评论列表是客户端拉取的**（CommentSection 的 comments 初始为
// []，SSR 期一条评论都不渲染），因此不存在服务端/客户端首帧不一致。若将来改成服务端
// 直出评论，这里必须改成「挂载后再渲染 Markdown」的门控写法。
// ─────────────────────────────────────────────────────────────────────────────

import { memo, useMemo } from 'react';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

function CommentMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderCommentMarkdown(content), [content]);
  if (!html) return null;
  return (
    <div
      className="comment-content__md"
      // html 来自 renderCommentMarkdown：已过 DOMPurify 白名单净化 + 链接加固
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default memo(CommentMarkdown);
