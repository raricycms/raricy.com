'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// 个人主页「文章 / 评论」标签页 — Flask BEM 样式
// tab 切换在客户端完成；分页走整页刷新。
interface BlogItem {
  id: string;
  title: string;
  createdAt: string | null;
  likesCount: number;
  description: string;
  commentsCount: number;
}
interface CommentItem {
  id: string;
  blogId: string;
  blogTitle: string;
  content: string;
  createdAt: string | null;
}

interface Props {
  userId: string;
  initialTab: 'blogs' | 'comments';
  blogsCount: number;
  commentsCount: number;
  showBlogs: boolean;
  showComments: boolean;
  blogItems: BlogItem[];
  commentItems: CommentItem[];
  blogPage: number;
  blogPages: number;
  commentPage: number;
  commentPages: number;
}

function ymd(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function Pager({
  which,
  page,
  pages,
  buildHref,
  onJump,
}: {
  which: 'blogs' | 'comments';
  page: number;
  pages: number;
  buildHref: (which: 'blogs' | 'comments', p: number) => string;
  onJump: (which: 'blogs' | 'comments', p: number) => void;
}) {
  if (pages <= 1) return null;

  const win = 3;
  const items: (number | '...')[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || (p >= page - win && p <= page + win)) {
      items.push(p);
    } else if (p === page - win - 1 || p === page + win + 1) {
      items.push('...');
    }
  }

  function jump(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('jump') as HTMLInputElement | null;
    let target = parseInt(input?.value ?? '', 10);
    if (isNaN(target) || target < 1) target = 1;
    if (target > pages) target = pages;
    onJump(which, target);
  }

  return (
    <nav className="pagination" aria-label="分页">
      {page > 1 && (
        <Link href={buildHref(which, page - 1)} className="page-link">
          ‹
        </Link>
      )}
      {items.map((p, i) =>
        p === '...' ? (
          <span key={`e${i}`} className="page-ellipsis">
            …
          </span>
        ) : (
          <Link
            key={p}
            href={buildHref(which, p)}
            className={`page-link${p === page ? ' active' : ''}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Link>
        )
      )}
      {page < pages && (
        <Link href={buildHref(which, page + 1)} className="page-link">
          ›
        </Link>
      )}
      <form className="page-jump" onSubmit={jump}>
        <input
          type="number"
          name="jump"
          min={1}
          max={pages}
          placeholder={String(page)}
          className="page-input"
        />
        <button type="submit" className="btn btn-outline-primary btn-sm page-btn">
          跳转
        </button>
      </form>
    </nav>
  );
}

export default function ProfileTabs({
  userId,
  initialTab,
  blogsCount,
  commentsCount,
  showBlogs,
  showComments,
  blogItems,
  commentItems,
  blogPage,
  blogPages,
  commentPage,
  commentPages,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<'blogs' | 'comments'>(initialTab);

  function buildHref(which: 'blogs' | 'comments', p: number): string {
    const bp = which === 'blogs' ? p : blogPage;
    const cp = which === 'comments' ? p : commentPage;
    return `/u/${userId}?tab=${which}&blog_page=${bp}&comment_page=${cp}`;
  }

  function handleJump(which: 'blogs' | 'comments', p: number) {
    router.push(buildHref(which, p));
  }

  function selectTab(target: 'blogs' | 'comments') {
    setTab(target);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', target);
    window.history.replaceState({}, '', url.toString());
  }

  return (
    <>
      <div className="profile-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'blogs'}
          className={`profile-tabs__tab${tab === 'blogs' ? ' profile-tabs__tab--active' : ''}`}
          onClick={() => selectTab('blogs')}
        >
          文章 ({blogsCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'comments'}
          className={`profile-tabs__tab${tab === 'comments' ? ' profile-tabs__tab--active' : ''}`}
          onClick={() => selectTab('comments')}
        >
          评论 ({commentsCount})
        </button>
      </div>

      <div
        role="tabpanel"
        hidden={tab !== 'blogs'}
        id="tab-blogs"
        className={`profile-tab-panel${tab === 'blogs' ? ' profile-tab-panel--active' : ''}`}
      >
        {!showBlogs ? (
          <div className="profile-privacy-notice">
            <span className="icon icon-bell" aria-hidden="true" />
            <p>该用户设置了文章不可见</p>
          </div>
        ) : blogItems.length === 0 ? (
          <div className="profile-empty">
            <span className="icon icon-journal-text" aria-hidden="true" />
            <p>还没有发布过文章</p>
          </div>
        ) : (
          <>
            <div className="profile-content-list">
              {blogItems.map((b) => (
                <Link
                  key={b.id}
                  href={`/blog/${b.id}`}
                  className="profile-content-item"
                >
                  <h4 className="profile-content-item__title">{b.title}</h4>
                  {b.description && (
                    <p className="profile-content-item__preview">{b.description}</p>
                  )}
                  <div className="profile-content-item__meta">
                    <span>{ymd(b.createdAt)}</span>
                    <span>
                      <span className="icon icon-heart-fill" aria-hidden="true" />
                      {b.likesCount}
                    </span>
                    <span>
                      <span className="icon icon-chat-dots_new" aria-hidden="true" />
                      {b.commentsCount}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
            <Pager
              which="blogs"
              page={blogPage}
              pages={blogPages}
              buildHref={buildHref}
              onJump={handleJump}
            />
          </>
        )}
      </div>

      <div
        role="tabpanel"
        hidden={tab !== 'comments'}
        id="tab-comments"
        className={`profile-tab-panel${tab === 'comments' ? ' profile-tab-panel--active' : ''}`}
      >
        {!showComments ? (
          <div className="profile-privacy-notice">
            <span className="icon icon-bell" aria-hidden="true" />
            <p>该用户设置了评论不可见</p>
          </div>
        ) : commentItems.length === 0 ? (
          <div className="profile-empty">
            <span className="icon icon-chat-dots_new" aria-hidden="true" />
            <p>还没有发表过评论</p>
          </div>
        ) : (
          <>
            <div className="profile-content-list">
              {commentItems.map((c) => (
                <Link
                  key={c.id}
                  href={`/blog/${c.blogId}#comment-${c.id}`}
                  className="profile-content-item"
                >
                  <h4 className="profile-content-item__title">回复：{c.blogTitle}</h4>
                  <p className="profile-content-item__preview">{c.content}</p>
                  <div className="profile-content-item__meta">
                    <span>{ymd(c.createdAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
            <Pager
              which="comments"
              page={commentPage}
              pages={commentPages}
              buildHref={buildHref}
              onJump={handleJump}
            />
          </>
        )}
      </div>
    </>
  );
}
