'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import Avatar from '@/app/components/Avatar';
import { BLOG_SCOPES, type BlogScope } from '@/lib/blog-directory';

export default function BlogPersonalSidebar({ user, summary, scope }: {
  user: { id: string; username: string; frameUrl: string | null };
  summary: { counts: Record<BlogScope, number>; likesReceived: number; fishReceived: number };
  scope: BlogScope;
}) {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const host = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const params = useSearchParams();

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
      className={`blog-personal${open ? ' is-open' : ''}`}
      aria-label="我的博客"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
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
              <div className="blog-likes"><dt><span className="icon icon-heart-fill" aria-hidden="true" />获赞</dt><dd className="numeric">{summary.likesReceived}</dd></div>
              <div className="blog-fish"><dt><span className="icon icon-fish" aria-hidden="true" />收获鱼干</dt><dd className="numeric">{summary.fishReceived}</dd></div>
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
            <Link href="/blog/upload" className="blog-personal__create">
              <span className="icon icon-add" aria-hidden="true" />创建
            </Link>
          </div>
        </div>
      </div>
    </aside>
  );
}
