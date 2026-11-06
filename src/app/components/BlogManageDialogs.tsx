'use client';

// BlogManageDialogs — 文章详情页「作者/管理员写路径」的两个确认弹窗。
//
// 事实归属：
//   · BlogVisibilityDialog：Blog.visibility + BlogVisibilityLog，唯一写者是
//     PATCH /api/blogs/:id（blog-service.setBlogVisibility）；
//   · BlogDeleteDialog：Blog 软删 + 审计，唯一写者是 DELETE /api/blogs/:id
//     （管理员删他人文章需填原因，见 admin-blog-service）。
// 两者都只对 canManage/canEdit 渲染；取消回到「管理文章」目录（不是直接关闭），
// 与壳层 FeedButton 的 overlay 编排一致。

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BLOG_VISIBILITIES, VISIBILITY_LABEL } from '@/lib/blog-visibility';
import type { BlogVisibility } from '@/lib/blog-visibility';

function toast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

interface VisibilityProps {
  blogId: string;
  initialVisibility: BlogVisibility;
  lastVisibilityChange?: string | null;
  open: boolean;
  onClose: () => void;
  onReturnToManage: () => void;
}

export function BlogVisibilityDialog({
  blogId,
  initialVisibility,
  lastVisibilityChange = null,
  open,
  onClose,
  onReturnToManage,
}: VisibilityProps) {
  const router = useRouter();
  // visibility = 服务端确认过的档位；visDraft = 弹窗里正在挑的那个。
  // 分成两个而不是共用一个：取消 / 关闭弹窗要能丢弃草稿，否则「点开看了一眼又关掉」
  // 会把界面留在未提交的状态上。
  const [visibility, setVisibility] = useState<BlogVisibility>(initialVisibility);
  const [visDraft, setVisDraft] = useState<BlogVisibility>(initialVisibility);
  const [visBusy, setVisBusy] = useState(false);

  // 每次打开都从「服务端确认过的档位」重来（等价于原先点目录项时的 setVisDraft(visibility)）。
  useEffect(() => {
    if (open) setVisDraft(visibility);
  }, [open, visibility]);

  // 可见性：提交草稿。**只走窄接口 PATCH**，不是拿 PUT 把整篇回传一遍
  // （那样既有丢更新的竞态，又把正文白往返一趟）。
  async function saveVisibility() {
    if (visBusy) return;
    if (visDraft === visibility) {
      toast('可见性没有变化', 'info');
      onReturnToManage();
      return;
    }
    setVisBusy(true);
    try {
      const res = await fetch(`/api/blogs/${blogId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ visibility: visDraft }),
      });
      const data = await res.json().catch(() => ({ code: res.status, message: '设置失败' }));
      if (res.ok) {
        setVisibility(visDraft);
        toast(data.message || '已更新可见性', 'success');
        // ⚠️ 必须让服务端重渲染，不能只改本地 state：robots 元数据、OG 卡片、JSON-LD
        // 与页脚的「对外公开」状态**全部在服务端算**。只改本地的话，这个标签页会停在
        // 「界面说站内、响应头说 public」的不一致里，而刷新一下又好了 —— 最难查的那种。
        router.refresh();
        onClose();
      } else {
        toast(data.message || '设置失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setVisBusy(false);
    }
  }

  return (
    <div
      className={`modal${open ? ' is-open' : ''}`}
      id="visibilityModal"
      role="dialog"
      aria-hidden={!open}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">设置可见性</h5>
            <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <p className="form-hint text-muted">当前：{VISIBILITY_LABEL[visibility]}</p>
            {/* 「上次变更」—— 公开是不可逆的，所以「我什么时候放出去的」是这一档
                唯一值得回看的信息。数据来自 blog_visibility_logs（见迁移 19）。 */}
            {lastVisibilityChange && (
              <p className="form-hint text-muted numeric">上次变更：{lastVisibilityChange}</p>
            )}
            {BLOG_VISIBILITIES.map((v) => (
              <div className="form-check" key={v}>
                <input
                  type="radio"
                  className="form-check-input"
                  name="visibility"
                  id={`vis-${v}`}
                  value={v}
                  checked={visDraft === v}
                  onChange={() => setVisDraft(v)}
                />
                <label className="form-check-label" htmlFor={`vis-${v}`}>
                  {VISIBILITY_LABEL[v]}
                </label>
              </div>
            ))}
            <span className="form-hint text-muted">
              仅站内可见：只有站内核心用户读得到。凭链接可读：拿到链接的任何人可读，
              但不进任何列表、不被搜索引擎收录。对外公开：任何人可读，可能被搜索引擎
              收录与第三方存档。
            </span>
            {/* 这句必须留着：public 是**唯一不可逆**的那一档，而它恰好是作者最容易
                顺手点下去的一档（「让朋友看到」）。 */}
            <span className="form-hint text-muted">
              ⚠️ 改为「对外公开」后可能被搜索引擎与第三方存档抓走副本，之后改回
              「仅站内可见」不会收回已经抓走的副本。
            </span>
          </div>
          <div className="modal-footer">
            {/* 取消：回到「管理文章」目录而非直接关闭（与删除弹窗同款） */}
            <button type="button" className="button button-primary" onClick={onReturnToManage}>
              取消
            </button>
            <button
              type="button"
              id="confirm-visibility-btn"
              className="button button-warning"
              onClick={saveVisibility}
              disabled={visBusy}
            >
              确认修改
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DeleteProps {
  blogId: string;
  blogTitle: string;
  isAdminDelete: boolean;
  open: boolean;
  onClose: () => void;
  onReturnToManage: () => void;
}

export function BlogDeleteDialog({
  blogId,
  blogTitle,
  isAdminDelete,
  open,
  onClose,
  onReturnToManage,
}: DeleteProps) {
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete() {
    if (isAdminDelete && !deleteReason.trim()) {
      toast('请填写删除原因', 'warning');
      return;
    }
    setDeleteBusy(true);
    try {
      const url = isAdminDelete ? `/api/admin/blogs/${blogId}` : `/api/blogs/${blogId}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: isAdminDelete ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'same-origin',
        body: isAdminDelete ? JSON.stringify({ reason: deleteReason.trim() }) : undefined,
      });
      const data = await res.json().catch(() => ({ code: res.status, message: '删除失败' }));
      if (data.code === 200) {
        toast('文章已删除', 'success');
        window.location.href = '/blog';
      } else {
        toast(data.message || '删除失败', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div
      className={`modal${open ? ' is-open' : ''}`}
      id="deleteConfirmModal"
      role="dialog"
      aria-hidden={!open}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">确认删除</h5>
            <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
          </div>
          <div className="modal-body">
            确定要删除这篇文章《{blogTitle}》吗？该操作不可恢复。
            {isAdminDelete && (
              <div className="mt-3">
                <label htmlFor="delete-reason" className="form-label">
                  删除原因（管理员必填，将通知作者）：
                </label>
                <textarea
                  id="delete-reason"
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
            {/* 取消：回到「管理文章」目录而非直接关闭 */}
            <button type="button" className="button button-primary" onClick={onReturnToManage}>
              取消
            </button>
            <button
              type="button"
              id="confirm-delete-btn"
              className="button button-warning"
              onClick={confirmDelete}
              disabled={deleteBusy}
            >
              确认删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
