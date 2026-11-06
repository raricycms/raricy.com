'use client';

// BlogManageMenu — 文章详情页「作者/管理员写路径」的入口目录。
//
// 它只负责「管理文章」这颗齿轮 + 目录本身（点赞者 / 投喂者 / 编辑 / 可见性 / 删除），
// 不持有任何事实状态：
//   · 可见性 PATCH 在 BlogManageDialogs.BlogVisibilityDialog；
//   · 删除 DELETE 在 BlogManageDialogs.BlogDeleteDialog；
//   · 点赞者 / 投喂者只读投影在 BlogAudienceDialogs。
// 开合、外部点击与焦点归还由壳层 FeedButton 编排（containerRef / toggleRef 由壳层持有）。

import type { RefObject } from 'react';

export type BlogManageView = 'likers' | 'feeders' | 'visibility' | 'delete';

interface Props {
  blogId: string;
  /** 目录是否展开（壳层 overlay === 'menu'）。 */
  open: boolean;
  /** 是否作者本人（编辑与可见性只对作者出现）。 */
  canEdit: boolean;
  onToggle: () => void;
  /** 焦点离开整颗管理控件时收起目录。 */
  onClose: () => void;
  onOpenView: (view: BlogManageView) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
}

export default function BlogManageMenu({
  blogId,
  open,
  canEdit,
  onToggle,
  onClose,
  onOpenView,
  containerRef,
  toggleRef,
}: Props) {
  return (
    <div
      ref={containerRef}
      className={`manage-control${open ? ' is-open' : ''}`}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <button
        ref={toggleRef}
        id="admin-manage-btn"
        className="manage-control__toggle"
        onClick={onToggle}
        aria-label="管理文章"
        title="管理文章"
        aria-expanded={open}
        aria-controls="blog-manage-menu"
      >
        <span className="icon icon-gear-fill" aria-hidden="true" />
      </button>
      <div className="manage-control__panel" inert={!open} aria-hidden={!open}>
        <div className="manage-menu" id="blog-manage-menu" role="group" aria-label="文章管理操作">
          <button type="button" className="manage-menu__item" onClick={() => onOpenView('likers')} aria-label="点赞者" title="点赞者">
            <span className="icon icon-person-heart-fill" aria-hidden="true" /><span>点赞者</span>
          </button>
          <button type="button" className="manage-menu__item" onClick={() => onOpenView('feeders')} aria-label="投喂者" title="投喂者">
            <span className="icon icon-person-fish-fill" aria-hidden="true" /><span>投喂者</span>
          </button>
          {canEdit && (
            <a href={`/blog/${blogId}/edit`} className="manage-menu__item" aria-label="编辑" title="编辑">
              <span className="icon icon-pencil-fill" aria-hidden="true" /><span>编辑</span>
            </a>
          )}
          {/* 编辑与可见性仅作者可用，服务端 PATCH / PUT 也只认作者。 */}
          {canEdit && (
            <button type="button" className="manage-menu__item" aria-label="可见性" title="可见性" onClick={() => onOpenView('visibility')}>
              <span className="icon icon-eye-fill" aria-hidden="true" /><span>可见性</span>
            </button>
          )}
          <button type="button" className="manage-menu__item manage-menu__item--danger" onClick={() => onOpenView('delete')} aria-label="删除" title="删除">
            <span className="icon icon-trash-fill" aria-hidden="true" /><span>删除</span>
          </button>
        </div>
      </div>
    </div>
  );
}
