'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// 个人主页「文章 / 评论」标签页。
//   • tab 切换：客户端切换、不刷新（对齐 profile.html 的 data-tab 逻辑 + replaceState 回写 ?tab=）。
//   • 分页：服务端真实翻页（对齐 profile.py 的 per_page=20）。«/»、页码、跳转均导航到带
//     blog_page/comment_page 的 URL，整页重新加载对应页数据；两个 tab 的页码相互保留。
// 数据由 Server Component 按当前页码注入（已是一整页切片）；隐私开关关闭时渲染 profile-privacy-notice。

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

// 服务端分页条：window-of-3 页码 + 省略号 + «/» + 跳转输入（对齐 profile.html 的 .pagination）。
// 每个链接都保留两个 tab 的页码（blog_page / comment_page），点击导航整页刷新加载新一批数据。
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
    <div className="pagination">
      {page > 1 && (
        <Link href={buildHref(which, page - 1)} className="page-link">
          &laquo;
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
            className={`page-link ${p === page ? 'active' : ''}`}
          >
            {p}
          </Link>
        ),
      )}
      {page < pages && (
        <Link href={buildHref(which, page + 1)} className="page-link">
          &raquo;
        </Link>
      )}
      <form className="page-jump" onSubmit={jump}>
        <input type="number" name="jump" min={1} max={pages} placeholder={String(page)} className="page-input" />
        <button type="submit" className="page-link">
          跳转
        </button>
      </form>
    </div>
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

  // 构造分页链接：保留两个 tab 的页码（未变的那个沿用当前服务端页码），并把目标 tab 写进 URL。
  function buildHref(which: 'blogs' | 'comments', p: number): string {
    const bp = which === 'blogs' ? p : blogPage;
    const cp = which === 'comments' ? p : commentPage;
    return `/u/${userId}?tab=${which}&blog_page=${bp}&comment_page=${cp}`;
  }

  // 跳转输入框：导航到目标页（整页刷新，对齐 profile.html 的 window.location.href 跳转）。
  function handleJump(which: 'blogs' | 'comments', p: number) {
    router.push(buildHref(which, p));
  }

  // 对齐 profile.html 的 tab 切换：客户端切换、不刷新，切换后把 ?tab= 写回地址栏（replaceState，不新增历史）。
  function selectTab(target: 'blogs' | 'comments') {
    setTab(target);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', target);
    window.history.replaceState({}, '', url.toString());
  }

  return (
    <>
      <div className="profile-tabs">
        <button
          type="button"
          className={`profile-tabs__tab ${tab === 'blogs' ? 'profile-tabs__tab--active' : ''}`}
          data-tab="blogs"
          onClick={() => selectTab('blogs')}
        >
          文章 ({blogsCount})
        </button>
        <button
          type="button"
          className={`profile-tabs__tab ${tab === 'comments' ? 'profile-tabs__tab--active' : ''}`}
          data-tab="comments"
          onClick={() => selectTab('comments')}
        >
          评论 ({commentsCount})
        </button>
      </div>

      <div
        className={`profile-tab-panel ${tab === 'blogs' ? 'profile-tab-panel--active' : ''}`}
        id="tab-blogs"
      >
        {!showBlogs ? (
          <div className="profile-privacy-notice">
            <span className="icon icon-lock2"></span>该用户设置了文章不可见
          </div>
        ) : blogItems.length === 0 ? (
          <div className="profile-empty">
            <span className="icon icon-journal-text"></span>还没有发布过文章
          </div>
        ) : (
          <>
            <div className="profile-content-list">
              {blogItems.map((b) => (
                <Link key={b.id} href={`/blog/${b.id}`} className="card profile-content-item">
                  <div className="profile-content-item__title">{b.title}</div>
                  {b.description && (
                    <div className="profile-content-item__preview">{b.description}</div>
                  )}
                  <div className="profile-content-item__meta">
                    <span>{ymd(b.createdAt)}</span>
                    <span>
                      <span className="icon icon-heart-fill"></span>
                      {b.likesCount}
                    </span>
                    <span>
                      <span className="icon icon-chat-dots_new"></span>
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
        className={`profile-tab-panel ${tab === 'comments' ? 'profile-tab-panel--active' : ''}`}
        id="tab-comments"
      >
        {!showComments ? (
          <div className="profile-privacy-notice">
            <span className="icon icon-lock2"></span>该用户设置了评论不可见
          </div>
        ) : commentItems.length === 0 ? (
          <div className="profile-empty">
            <span className="icon icon-chat-dots_new"></span>还没有发表过评论
          </div>
        ) : (
          <>
            <div className="profile-content-list">
              {commentItems.map((c) => (
                <Link
                  key={c.id}
                  href={`/blog/${c.blogId}#comment-${c.id}`}
                  className="card profile-content-item"
                >
                  <div className="profile-content-item__title">回复：{c.blogTitle}</div>
                  <div className="profile-content-item__preview">{c.content}</div>
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
