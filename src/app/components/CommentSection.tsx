'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CommentSection.tsx — 博客评论区（楼中楼 + 软删除 + 附件）
//
// 【输入区与聊天同源】正文支持 Markdown、可传图床图片、可引用博客 —— 全部复用
// src/app/components/RichComposer（与聊天同一份组件，样式前缀换成 comment-composer），
// 上传走同一套 usePendingImage / image-client。
//
// 【正文的渲染】服务端下发 content（Markdown 原文），这里经 renderCommentMarkdown
// 净化后注入。★ 绝不能拿 content 直接 innerHTML ★ —— 它是用户输入，净化管线
// （marked → DOMPurify → 后处理）在 src/lib/rich-text.ts，白名单在
// src/lib/comment-markdown.ts。content_html 是服务端转义的纯文本，站内不再用它渲染
// （保留给 spider API 与无 JS 降级）。
//
// 【回复是「就地」的】点某条评论的「回复」，表单整块移动到那条评论下方（不是弹窗）。
// 这是评论与聊天的语义差异：聊天回复是引用一条消息，评论回复是挂到某个父级下面
// （parent_id 决定楼中楼的位置）。两边的输入区长得一样，语义不混。
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpenText } from 'lucide-react';
import RichComposer, { type ComposerBlogQuote } from './RichComposer';
import QuoteBlogModal from './QuoteBlogModal';
import ImageLightbox from './ImageLightbox';
import CommentMarkdown from './CommentMarkdown';
import { usePendingImage } from './usePendingImage';
import { COMMENT_TEXT_MAX, COMMENT_CAPTION_MAX } from '@/lib/comment-shared';

declare global {
  interface Window {
    showToast?: (m: string, t?: string) => void;
  }
}

function toast(msg: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(msg, type);
}

// 与 comment-service 序列化 JSON 形状一致（snake_case）
interface CommentAttachmentImage {
  id: string;
  url: string;
  mime_type: string;
}

interface CommentAttachmentBlog {
  id: string;
  title: string;
  description: string;
  author: string | null;
  updated_at: string | null;
}

interface CommentNode {
  id: string;
  blog_id: string;
  author: { id: string | null; username: string | null; is_admin: boolean; avatar_url: string | null };
  parent_id: string | null;
  root_id: string | null;
  /** Markdown 原文 —— 必须经 renderCommentMarkdown 净化后才能注入 DOM */
  content: string;
  content_html: string;
  image: CommentAttachmentImage | null;
  image_missing: boolean;
  blog: CommentAttachmentBlog | null;
  blog_missing: boolean;
  status: string | null;
  is_deleted: boolean;
  likes_count: number;
  created_at: string | null;
  updated_at: string | null;
  children: CommentNode[];
}

interface Props {
  blogId: string;
  /** 当前登录用户 id；未登录传 null。用于显示删除入口。 */
  currentUserId?: string | null;
  /** 当前用户是否有管理员权限（可删他人评论）。 */
  isAdmin?: boolean;
  /** 是否可发表评论（对齐 Flask：已登录 且 核心用户）。未传则回退到「已登录」。 */
  canComment?: boolean;
}

/** 正在回复的目标（就地表单挂到它下面，并作为 parent_id 提交）。 */
interface ReplyTarget {
  id: string;
  username: string;
  preview: string;
}

/** 回复条预览文案：与聊天同一口径 —— 正文为空时按附件给占位，别显示成「回复 某某：」空着。 */
function replyPreview(node: CommentNode): string {
  const collapsed = node.content.replace(/\s+/g, ' ').trim();
  if (collapsed) return collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed;
  if (node.image) return '[图片]';
  if (node.image_missing) return '[图片已删除]';
  if (node.blog) return `[博客] ${node.blog.title}`;
  return '';
}

async function api(url: string, init?: RequestInit): Promise<{ code: number; message: string; [k: string]: unknown }> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  return (await res.json().catch(() => ({ code: res.status, message: '请求失败' }))) as {
    code: number;
    message: string;
    [k: string]: unknown;
  };
}

export default function CommentSection({ blogId, currentUserId = null, isAdmin = false, canComment: canCommentProp }: Props) {
  const [comments, setComments] = useState<CommentNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [blogQuote, setBlogQuote] = useState<ComposerBlogQuote | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { pendingImage, uploadingImage, pickImage, clearImage } = usePendingImage(toast);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 删除确认模态框状态（对齐 comment-manager.js 的两步删除）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteRequiresReason, setDeleteRequiresReason] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api(`/api/blogs/${blogId}/comments`);
    if (data.code === 200 && Array.isArray(data.comments)) {
      setComments(data.comments as CommentNode[]);
    }
    setLoading(false);
  }, [blogId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 就地回复：表单移动到被回复评论下方后聚焦
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  const submit = useCallback(async () => {
    const content = text.trim();
    if (submitting) return;
    const hasAttach = !!pendingImage || !!blogQuote;
    if (!content && !hasAttach) {
      toast('评论内容不能为空', 'info');
      return;
    }
    // 带附件时按图注档限长（与服务端 COMMENT_CAPTION_MAX 同口径；服务端才是权威）
    const limit = hasAttach ? COMMENT_CAPTION_MAX : COMMENT_TEXT_MAX;
    if (content.length > limit) {
      toast(hasAttach ? `图片或引用评论不能超过${limit}字` : `评论内容不能超过${limit}字`, 'info');
      return;
    }
    setSubmitting(true);
    const data = await api(`/api/blogs/${blogId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        parent_id: replyTo?.id ?? null,
        ...(pendingImage ? { image_id: pendingImage.id } : {}),
        ...(blogQuote ? { quote_blog_id: blogQuote.id } : {}),
      }),
    });
    if (data.code === 200) {
      toast('评论发表成功', 'success');
      setText('');
      setReplyTo(null); // 表单移回顶部
      setBlogQuote(null);
      clearImage();
      if (textareaRef.current) textareaRef.current.style.height = '';
      await load();
    } else {
      toast(data.message || '发表失败', 'error');
    }
    setSubmitting(false);
  }, [text, replyTo, submitting, blogId, load, pendingImage, blogQuote, clearImage]);

  // 打开删除确认模态框（管理员删他人评论时要求填写原因）
  const openDeleteModal = useCallback((id: string, requiresReason: boolean) => {
    setDeleteTarget(id);
    setDeleteRequiresReason(requiresReason);
    setDeleteReason('');
  }, []);

  const performDelete = useCallback(async () => {
    if (!deleteTarget || deleteBusy) return;
    let body: string | undefined;
    if (deleteRequiresReason) {
      const reason = deleteReason.trim();
      if (!reason) {
        toast('请填写删除原因', 'warning');
        return;
      }
      body = JSON.stringify({ reason });
    }
    setDeleteBusy(true);
    const data = await api(`/api/comments/${deleteTarget}`, { method: 'DELETE', body });
    if (data.code === 200) {
      toast('评论已删除', 'success');
      setDeleteTarget(null);
      await load();
    } else {
      toast(data.message || '删除失败', 'error');
    }
    setDeleteBusy(false);
  }, [deleteTarget, deleteRequiresReason, deleteReason, deleteBusy, load]);

  const canComment = canCommentProp ?? !!currentUserId;

  const form = canComment ? (
    <div className="comment-form" id="comment-form">
      <RichComposer
        className="comment-composer"
        text={text}
        sending={submitting}
        sendLabel="发表评论"
        sendingLabel="发表中…"
        // 占位符不必再报一次「回复 某某」—— 正上方的回复条已经写着，重复只是噪音
        placeholderLead="说点什么…"
        submitVerb="发表"
        pendingImage={pendingImage}
        uploadingImage={uploadingImage}
        replyChip={
          replyTo ? { label: `回复 ${replyTo.username}`, text: replyTo.preview } : null
        }
        blogQuote={blogQuote}
        textareaRef={textareaRef}
        onTextChange={setText}
        onSend={() => void submit()}
        onPickImage={(f) => void pickImage(f)}
        onOpenQuote={() => setQuoteOpen(true)}
        onClearReply={() => setReplyTo(null)}
        onClearBlogQuote={() => setBlogQuote(null)}
        onClearImage={clearImage}
        footerSlot={
          <span>
            {text.length > (pendingImage || blogQuote ? COMMENT_CAPTION_MAX : COMMENT_TEXT_MAX)
              ? `已超出${pendingImage || blogQuote ? COMMENT_CAPTION_MAX : COMMENT_TEXT_MAX}字上限`
              : `最多${pendingImage || blogQuote ? COMMENT_CAPTION_MAX : COMMENT_TEXT_MAX}字 · 支持 Markdown`}
          </span>
        }
      />
    </div>
  ) : null;

  return (
    <div className="blog-detail">
      <section className="comment-section" id="comment-section">
        {canComment ? (
          // 顶部只在未回复任何评论时渲染表单；回复时表单移动到评论下方
          !replyTo && form
        ) : (
          <div className="alert alert-info">只有"核心用户"可以发表评论。</div>
        )}

        {loading ? (
          <ul className="comment-list" id="comment-list">
            <li className="text-muted">加载评论中…</li>
          </ul>
        ) : (
          <ul className="comment-list" id="comment-list">
            {comments.map((c) => (
              <CommentItem
                key={c.id}
                node={c}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                onReply={(n) =>
                  setReplyTo({ id: n.id, username: n.author.username ?? '匿名用户', preview: replyPreview(n) })
                }
                onDelete={openDeleteModal}
                onImageClick={setLightbox}
                canComment={canComment}
                replyTo={replyTo}
                replyForm={form}
              />
            ))}
          </ul>
        )}
      </section>

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

      {lightbox && <ImageLightbox src={lightbox} alt="评论图片" onClose={() => setLightbox(null)} />}

      {/* 删除确认模态框（对齐 modal_system.html 的 commentDeleteModal）*/}
      <div
        className={`modal fade${deleteTarget ? ' show' : ''}`}
        id="commentDeleteModal"
        role="dialog"
        aria-hidden={!deleteTarget}
        onClick={(e) => e.target === e.currentTarget && setDeleteTarget(null)}
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">确认删除评论</h5>
              <button type="button" className="btn-close" aria-label="Close" onClick={() => setDeleteTarget(null)} />
            </div>
            <div className="modal-body">
              <div className="text-muted">确定要删除该评论吗？</div>
              {deleteRequiresReason && (
                <div className="mt-3">
                  <label htmlFor="comment-delete-reason" className="form-label">
                    删除原因（管理员必填，将通知用户）：
                  </label>
                  <textarea
                    id="comment-delete-reason"
                    className="form-control"
                    rows={3}
                    maxLength={500}
                    placeholder="请填写删除原因…"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="button button-primary" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                type="button"
                id="comment-confirm-delete-btn"
                className="button button-warning"
                onClick={performDelete}
                disabled={deleteBusy}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentItem({
  node,
  currentUserId,
  isAdmin,
  onReply,
  onDelete,
  onImageClick,
  canComment,
  replyTo,
  replyForm,
}: {
  node: CommentNode;
  currentUserId: string | null;
  isAdmin: boolean;
  onReply: (node: CommentNode) => void;
  onDelete: (id: string, requiresReason: boolean) => void;
  onImageClick: (url: string) => void;
  canComment: boolean;
  replyTo: ReplyTarget | null;
  replyForm: React.ReactNode;
}) {
  const authorName = node.author.username ?? '匿名用户';
  const canDelete = isAdmin || (!!currentUserId && currentUserId === node.author.id);
  // 管理员删他人评论需填写原因
  const requiresReason = isAdmin && (!node.author.id || node.author.id !== currentUserId);
  const authorAvatar = node.author.avatar_url ? (
    <img className="comment-author-avatar" src={node.author.avatar_url} alt={authorName} />
  ) : null;

  return (
    <li className="comment-item">
      <div className="comment-meta">
        {node.author.id ? (
          // 有账号的评论者：点击头像/名称跳转个人主页
          <Link href={`/u/${node.author.id}`} className="comment-author-link" title={authorName}>
            {authorAvatar}
            <span>{authorName}</span>
          </Link>
        ) : (
          <>
            {authorAvatar}
            <span>{authorName}</span>
          </>
        )}
      </div>

      {/* 正文：CommentMarkdown 内部走 renderCommentMarkdown 净化（见文件头） */}
      {node.content ? (
        <div className="comment-content">
          <CommentMarkdown content={node.content} />
        </div>
      ) : null}

      {/* 附件：图片可点开放大；引用博客整卡可点。均为读时解析，软删的评论服务端不下发 */}
      {node.image && (
        <img
          className="comment-image"
          src={node.image.url}
          alt="评论图片"
          loading="lazy"
          onClick={() => onImageClick(node.image!.url)}
        />
      )}
      {node.image_missing && <div className="comment-image-missing">[图片已删除]</div>}
      {node.blog && (
        <a className="comment-blog" href={`/blog/${node.blog.id}`}>
          <span className="comment-blog__icon" aria-hidden="true">
            <BookOpenText />
          </span>
          <span className="comment-blog__main">
            <span className="comment-blog__title">{node.blog.title}</span>
            {node.blog.author ? <span className="comment-blog__author">@{node.blog.author}</span> : null}
          </span>
        </a>
      )}
      {node.blog_missing && <div className="comment-blog-missing">[博客已删除]</div>}

      <div className="actions">
        {canComment && (
          <button type="button" className="button button-primary-small" onClick={() => onReply(node)}>
            回复
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="button button-warning-small"
            onClick={() => onDelete(node.id, requiresReason)}
          >
            删除
          </button>
        )}
      </div>

      {/* 就地回复：表单移动到本条评论下方 */}
      {replyTo?.id === node.id && replyForm}

      {node.children.length > 0 && (
        <ul className="children comment-list">
          {node.children.map((child) => (
            <CommentItem
              key={child.id}
              node={child}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              onReply={onReply}
              onDelete={onDelete}
              onImageClick={onImageClick}
              canComment={canComment}
              replyTo={replyTo}
              replyForm={replyForm}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
