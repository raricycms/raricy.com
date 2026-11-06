'use client';

// BlogAudienceDialogs — 文章详情页「只读名单投影」：点赞者 / 投喂者。
//
// 这两个事实的唯一写者都在别处（BlogLike / BlogFeed 的写路径），这里只读
// GET /api/blogs/:id/{likers,feeders}，每个弹窗自己持有分页与错误态。
// 不抽「通用名单弹窗」泛型：两边的 DTO（LikerRow / FeederRow）与端点字段不同，
// 抽泛型只会多一层参数化（见 impl-split.md §3.1）。

import { useCallback, useEffect, useState } from 'react';
import Avatar from './Avatar';

// ⚠️ 这两个是**手抄**的服务端 DTO 形状（客户端组件 import 不了拖着 prisma 的
// blog-service / feed-service）。加了字段却忘了这里 → 那一处静默地没有框，
// 所以字段名要与服务端逐字对齐，别自己改名。
interface LikerRow {
  id: string;
  username: string;
  avatar_url?: string | null;
  frame_url?: string | null;
}
interface FeederRow {
  user_id: string;
  username: string;
  amount: number;
  avatar_path?: string | null;
  frame_url?: string | null;
}

interface DialogProps {
  blogId: string;
  open: boolean;
  onClose: () => void;
}

export function BlogLikersDialog({ blogId, open, onClose }: DialogProps) {
  const [likers, setLikers] = useState<LikerRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [msg, setMsg] = useState('');

  const load = useCallback(
    async (nextPage: number) => {
      setMsg('加载中...');
      setLikers([]);
      try {
        const limit = 20;
        const res = await fetch(`/api/blogs/${blogId}/likers?offset=${(nextPage - 1) * limit}&limit=${limit}`, {
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.code === 200) {
          const users: LikerRow[] = data.users || data.data?.users || [];
          const total = data.total || data.data?.total || 0;
          setLikers(users);
          setPage(nextPage);
          setPages(Math.max(1, Math.ceil(total / limit)));
          setMsg(users.length ? '' : '暂无点赞者');
        } else {
          setMsg(`加载失败: ${data.message || '未知错误'}`);
        }
      } catch {
        setMsg('网络错误，请稍后重试');
      }
    },
    [blogId]
  );

  // 打开时从第一页重新拉：与原先「点目录项 → 先切视图再拉列表」等价。
  useEffect(() => {
    if (open) void load(1);
  }, [open, load]);

  return (
    <div
      className={`modal${open ? ' is-open' : ''}`}
      id="likersModal"
      role="dialog"
      aria-hidden={!open}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title"><span className="icon icon-heart-fill" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>点赞者列表</h5>
            <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <div id="likers-list" className="list-group" style={{ maxHeight: '50vh', overflow: 'auto' }}>
              {msg ? (
                <div className="text-muted">{msg}</div>
              ) : (
                likers.map((u) => (
                  <div className="list-group-item" key={u.id}>
                    <div className="d-flex align-items-center">
                      <Avatar
                        userId={u.id}
                        src={u.avatar_url}
                        frameUrl={u.frame_url}
                        alt={u.username}
                        size={32}
                        style={{ marginRight: 10 }}
                      />
                      <strong>{u.username || '匿名用户'}</strong>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="d-flex justify-content-between align-items-center mt-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                disabled={page <= 1}
                onClick={() => load(page - 1)}
              >
                上一页
              </button>
              <small className="text-muted numeric">
                第 {page} 页，共 {pages} 页
              </small>
              <button
                className="btn btn-sm btn-outline-secondary"
                disabled={page >= pages}
                onClick={() => load(page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BlogFeedersDialog({ blogId, open, onClose }: DialogProps) {
  const [feeders, setFeeders] = useState<FeederRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [msg, setMsg] = useState('');

  const load = useCallback(
    async (nextPage: number) => {
      setMsg('加载中...');
      setFeeders([]);
      try {
        const limit = 20;
        const res = await fetch(`/api/blogs/${blogId}/feeders?offset=${(nextPage - 1) * limit}&limit=${limit}`, {
          credentials: 'same-origin',
        });
        const data = await res.json();
        if (data.code === 200) {
          const list: FeederRow[] = data.feeders || [];
          const total = data.total || 0;
          setFeeders(list);
          setPage(nextPage);
          setPages(Math.max(1, Math.ceil(total / limit)));
          setMsg(list.length ? '' : '暂无投喂者');
        } else {
          setMsg(`加载失败: ${data.message || '未知错误'}`);
        }
      } catch {
        setMsg('网络错误，请稍后重试');
      }
    },
    [blogId]
  );

  useEffect(() => {
    if (open) void load(1);
  }, [open, load]);

  return (
    <div
      className={`modal${open ? ' is-open' : ''}`}
      id="feedersModal"
      role="dialog"
      aria-hidden={!open}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title"><span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>投喂者列表</h5>
            <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <div id="feeders-list" className="list-group" style={{ maxHeight: '50vh', overflow: 'auto' }}>
              {msg ? (
                <div className="text-muted">{msg}</div>
              ) : (
                feeders.map((f) => (
                  <div className="list-group-item" key={f.user_id}>
                    <div className="d-flex align-items-center justify-content-between">
                      <div className="d-flex align-items-center">
                        {/* 此前这里是 `f.avatar_path ? A : A` 的死三元（两支逐字相同）。
                            avatar_path 那一列恒为 null，判据本身也是错的 —— 磁盘上的
                            遗留头像文件跟它无关。<Avatar> 走同一条永不 404 的读口。 */}
                        <Avatar
                          userId={f.user_id}
                          frameUrl={f.frame_url}
                          alt={f.username}
                          size={32}
                          style={{ marginRight: 10 }}
                        />
                        <strong>{f.username || '未知用户'}</strong>
                      </div>
                      <span
                        className="badge"
                        style={{
                          background: 'var(--color-brand-secondary)',
                          color: 'var(--color-brand-primary)',
                          fontSize: '0.9rem',
                        }}
                      >
                        <span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.3rem' }}></span><span className="numeric">{f.amount}</span>
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="d-flex justify-content-between align-items-center mt-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                disabled={page <= 1}
                onClick={() => load(page - 1)}
              >
                上一页
              </button>
              <small className="text-muted numeric">
                第 {page} 页，共 {pages} 页
              </small>
              <button
                className="btn btn-sm btn-outline-secondary"
                disabled={page >= pages}
                onClick={() => load(page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
