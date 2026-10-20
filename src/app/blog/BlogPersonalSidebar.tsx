'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import Avatar from '@/app/components/Avatar';
import { BLOG_SCOPES, type BlogScope } from '@/lib/blog-directory';

export default function BlogPersonalSidebar({ user, summary, scope }: {
  user: { id: string; username: string; frameUrl: string | null };
  summary: { counts: Record<BlogScope, number>; likesReceived: number; commentsReceived: number; fishReceived: number };
  scope: BlogScope;
}) {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [settled, setSettled] = useState(false);
  const host = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const params = useSearchParams();

  useLayoutEffect(() => {
    setSettled(false);
    if (!open) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setSettled(true); return; }
    const timer = window.setTimeout(() => setSettled(true), 450);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 992px)');
    const update = () => { setNarrow(media.matches); setOpen(false); };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function scopeHref(next: BlogScope) {
    const p = new URLSearchParams(params.toString());
    if (next === 'all') p.delete('scope');
    else p.set('scope', next);
    p.delete('page');
    return p.size ? `/blog?${p}` : '/blog';
  }

  return (
    <aside
      ref={host}
      className={`blog-personal${open ? ' is-open' : ''}${open && settled ? ' is-settled' : ''}`}
      aria-label="我的博客"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {/* 窄屏展开时的全屏暗色蒙版：点它收起（与 ESC、点外部同义）。
          颜色跟站内模态遮罩统一（0.5 黑），样式见 _directory.scss 的 __backdrop。
          它挂在 aside 里面而不是 portal：移动端 aside 本身就是 fixed，蒙版跟着一起
          显隐即可 —— 代价是文档上那个「点外部收起」的监听判不出它（它就在 aside 内），
          所以这里自己接 pointerdown。同理，桌面 display:none，不进任何渲染。 */}
      <div
        className="blog-personal__backdrop"
        aria-hidden="true"
        onPointerDown={() => setOpen(false)}
      />
      <div className="blog-personal__shell">
        <Link
          className="blog-personal__avatar"
          href={`/u/${user.id}`}
          aria-label={`${user.username}的主页`}
          tabIndex={narrow && !open ? -1 : undefined}
          aria-hidden={narrow && !open}
        >
          <Avatar userId={user.id} frameUrl={user.frameUrl} alt="" />
        </Link>
        <button
          ref={toggle}
          type="button"
          className="blog-personal__toggle"
          aria-label={open ? '收起我的博客' : '展开我的博客'}
          aria-expanded={open}
          aria-controls="blog-personal-panel"
          onClick={() => setOpen((value) => !value)}
        >
          <X aria-hidden="true" />
        </button>
        <div className="blog-personal__panel" id="blog-personal-panel" inert={narrow && !open}>
          <div className="blog-personal__inner">
            <Link className="blog-personal__identity" href={`/u/${user.id}`}>
              <span>{user.username}</span>
            </Link>
            <dl className="blog-personal__stats">
              <div className="blog-likes" title="获赞"><dt><span className="icon icon-heart-fill" aria-hidden="true" /><span className="visually-hidden">获赞</span></dt><dd className="numeric">+{summary.likesReceived}</dd></div>
              <div className="blog-comments" title="收到评论"><dt><span className="icon icon-chat-dots_new" aria-hidden="true" /><span className="visually-hidden">收到评论</span></dt><dd className="numeric">+{summary.commentsReceived}</dd></div>
              <div className="blog-fish" title="收获鱼干"><dt><span className="icon icon-fish" aria-hidden="true" /><span className="visually-hidden">收获鱼干</span></dt><dd className="numeric">+{summary.fishReceived}</dd></div>
            </dl>
            <nav className="blog-personal__ranges" aria-label="文章范围">
              {BLOG_SCOPES.map((item) => (
                <Link
                  key={item.value}
                  href={scopeHref(item.value)}
                  className={`blog-personal__range${scope === item.value ? ' is-active' : ''}`}
                  aria-current={scope === item.value ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  scroll={false}
                  prefetch={false}
                >
                  <span className={`icon ${item.icon}`} aria-hidden="true" />
                  <span>{item.label}</span>
                  <span className="numeric">{summary.counts[item.value]}</span>
                </Link>
              ))}
            </nav>
            {/* 绝对定位的「创建」占位：桌面不占位（CSS 里 display:none），窄屏展开时
                在范围下方空出按钮那一格，见 _directory.scss 的 __create-space 说明。 */}
            <span className="blog-personal__create-space" aria-hidden="true" />
          </div>
        </div>
        {/*
          「创建」同时是窄屏胶囊里的圆形加号：同一个链接只换形态，不另建一个按钮。
          收起时它是加号（点一下直达 /blog/upload），展开时它长成面板底部的创建按钮 ——
          尺寸 / 底色 / 文案都由 CSS 在 `.is-open` 下过渡（见 _directory.scss）。
          ⚠️ 它必须在 `.blog-personal__panel` **外面**：面板收起时整块 0 高，放进去
          加号会跟着被裁掉；而它是收起态唯一的创建入口。
        */}
        <Link href="/blog/upload" className="upload-button blog-personal__create">
          <span className="icon icon-add" aria-hidden="true" />
          <span className="blog-personal__create-label">创建</span>
        </Link>
      </div>
    </aside>
  );
}
