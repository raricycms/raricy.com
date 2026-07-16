'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    showToast?: (m: string, t?: string) => void;
  }
}

function toast(msg: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(msg, type);
}

// 与 comment-service 序列化 JSON 形状一致（snake_case）
interface CommentNode {
  id: string;
  blog_id: string;
  author: { id: string | null; username: string | null; is_admin: boolean; avatar_url: string | null };
  parent_id: string | null;
  root_id: string | null;
  content_html: string;
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
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
    if (!content) {
      toast('评论内容不能为空', 'info');
      return;
    }
    if (content.length > 2000) {
      toast('评论内容不能超过2000字', 'info');
      return;
    }
    setSubmitting(true);
    const data = await api(`/api/blogs/${blogId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parent_id: replyTo }),
    });
    if (data.code === 200) {
      toast('评论发表成功', 'success');
      setText('');
      setReplyTo(null); // 表单移回顶部
      await load();
    } else {
      toast(data.message || '发表失败', 'error');
    }
    setSubmitting(false);
  }, [text, replyTo, submitting, blogId, load]);

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
    <form
      className="comment-form"
      id="comment-form"
      style={{ overflow: 'auto' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textareaRef}
        name="content"
        id="comment-content"
        className="form-control"
        maxLength={2000}
        placeholder="说点什么…（最多2000字）"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2">
        <button
          type="submit"
          className="button button-primary"
          style={{ marginTop: '10px' }}
          disabled={submitting}
        >
          发表评论
        </button>
      </div>
      <input type="hidden" name="parent_id" id="comment-parent-id" value={replyTo ?? ''} readOnly />
    </form>
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
                onReply={setReplyTo}
                onDelete={openDeleteModal}
                canComment={canComment}
                replyTo={replyTo}
                replyForm={form}
              />
            ))}
          </ul>
        )}
      </section>

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
  canComment,
  replyTo,
  replyForm,
}: {
  node: CommentNode;
  currentUserId: string | null;
  isAdmin: boolean;
  onReply: (id: string) => void;
  onDelete: (id: string, requiresReason: boolean) => void;
  canComment: boolean;
  replyTo: string | null;
  replyForm: React.ReactNode;
}) {
  const authorName = node.author.username ?? '匿名用户';
  const canDelete = isAdmin || (!!currentUserId && currentUserId === node.author.id);
  // 管理员删他人评论需填写原因
  const requiresReason = isAdmin && (!node.author.id || node.author.id !== currentUserId);

  return (
    <li className="comment-item">
      <div className="comment-meta">
        {node.author.avatar_url && (
          <img className="comment-author-avatar" src={node.author.avatar_url} alt={authorName} />
        )}
        <span>{authorName}</span>
      </div>

      {/* content_html 由服务端 HTML 转义并转 <br>，仅含安全实体，可安全注入 */}
      <div className="comment-content" dangerouslySetInnerHTML={{ __html: node.content_html }} />

      <div className="actions">
        {canComment && (
          <button type="button" className="button button-primary-small" onClick={() => onReply(node.id)}>
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
      {replyTo === node.id && replyForm}

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
