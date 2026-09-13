'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CommentMarkdown.tsx — 评论正文的渲染壳（薄壳，与 ChatMarkdown 同构）
//
// 真正干活的全在别处：
//   · marked → DOMPurify → 后处理：@/lib/comment-markdown（白名单 + 五道防线）
//   · `[@<8位剪贴板ID>]` 的异步展开、内联图片的点击放大：./RichContentBody
//
// 这里只回答一个问题：**用哪个类名、哪个白名单**。
//
// 【水合说明】renderCommentMarkdown 在无 DOM 环境返回转义纯文本，客户端返回净化后的
// HTML —— 两者不同，但**评论列表是客户端拉取的**（CommentSection 的 comments 初始为
// []，SSR 期一条评论都不渲染），因此不存在服务端/客户端首帧不一致。若将来改成服务端
// 直出评论，这里必须改成「挂载后再渲染 Markdown」的门控写法。
// ─────────────────────────────────────────────────────────────────────────────

import RichContentBody from './RichContentBody';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

export default function CommentMarkdown({ content }: { content: string }) {
  return (
    <RichContentBody content={content} className="comment-content__md" render={renderCommentMarkdown} />
  );
}
