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

  // 窄屏展开时锁住 body 滚动。两条漏路都要堵：蒙版只有 touch-action: none，拦得住触摸
  // 手势却拦不住鼠标滚轮；而面板自己真正可滚时，滚到尽头还会把余量转交给后面那一页
  // （滚动链，SCSS 的 overscroll-behavior: contain 管这一半）。实测（390×844）：不锁时
  // 展开后把滚轮停在面板上，window.scrollY 从 0 直接被带到 105。
  // 锁法照 u/[id]/ProfileBoard.tsx 的详情层：先量滚动条宽度再用 padding-right 抵掉，
  // 直接 overflow: hidden 会让桌面窄窗口的滚动条消失、正文横向跳一下。
  // 收起 / 卸载（含链接导航）都走 cleanup 还原，别只在收起按钮里写。
  useEffect(() => {
    if (!open || !narrow) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) {
      const current = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + scrollbar}px`;
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [open, narrow]);

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
          层级刻意留在固定顶栏之下 —— 顶栏照常亮着，不参与变暗。
          它挂在 aside 里面而不是 portal：移动端 aside 本身就是 fixed，蒙版跟着一起
          显隐即可 —— 代价是文档上那个「点外部收起」的监听判不出它（它就在 aside 内），
          所以这里自己接点击。
          ⚠️ 收起必须挂 onClick，**不能**挂 onPointerDown：按下那一刻就收起的话，蒙版
          立刻 pointer-events: none，这次手势松手后生成的那一下 click 就直接落到它下面
          那张博客卡上 —— 面板收了、人也被带进了 /blog/<id>（Chromium 与 WebKit 都如此）。
          挂在 click 上时 pointerdown / pointerup / click 都发生在蒙版自己身上，点击不穿透；
          代价是「按住不放再拖开」不会收起，但那本来也不该算一次点击。 */}
      <div
        className="blog-personal__backdrop"
        aria-hidden="true"
        onClick={() => setOpen(false)}
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
