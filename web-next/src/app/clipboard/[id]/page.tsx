import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { notFound } from 'next/navigation';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { getClip } from '@/lib/clipboard-service';
import {
  ClipIdCopyButton,
  ClipActions,
  ClipContent,
  FooterCopyright,
} from './ClipDetailClient';

export const dynamic = 'force-dynamic';

// 403 页的页面级样式，逐字对齐 Flask errorhandlers/403.html 的 extra_css 内联 <style>。
const forbiddenCss = `
  .rainbow-error { position: relative; min-height: calc(100vh - var(--nav-h)); display: flex;
    align-items: center; justify-content: center; padding: 48px 24px; overflow: hidden; text-align: center; }

  /* 连续亮色斜向彩虹渐变 + 色相循环动画 */
  .rainbow-error__bg { position: absolute; inset: 0; z-index: 0;
    background: linear-gradient(to bottom right,
      #FF8C8C, #FFC060, #FFFF66, #80FFB0, #99E6FF, #A090FF, #EEB0EE);
    background-size: 100% 100%;
    animation: rainbow-hue-cycle 3s linear infinite; }
  @keyframes rainbow-hue-cycle { from { filter: hue-rotate(0deg); } to { filter: hue-rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .rainbow-error__bg { animation: none; } }

  .rainbow-error__box { position: relative; z-index: 1; max-width: 560px; width: 100%;
    padding: 44px 40px; border-radius: 20px;
    background: rgba(0, 0, 0, .58); border: 1px solid rgba(255, 255, 255, .22);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 20px 60px rgba(0, 0, 0, .35); color: #fff; }
  .rainbow-error__code { font-size: clamp(4.5rem, 15vw, 7rem); font-weight: 800; line-height: 1;
    letter-spacing: -.04em; text-shadow: 0 0 24px rgba(255, 255, 255, .45); }
  .rainbow-error__title { font-size: clamp(1.4rem, 4vw, 1.9rem); font-weight: 700; margin-top: 8px; color: #fff; }
  .rainbow-error__msg { margin-top: 14px; font-size: 1.02rem; color: rgba(255, 255, 255, .9); }
  .rainbow-error__hint { margin-top: 8px; font-size: .9rem; color: rgba(255, 255, 255, .72); line-height: 1.7; }

  .rainbow-error__actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 30px; }
  .rainbow-error__btn { display: inline-flex; align-items: center; gap: 7px; padding: 11px 22px;
    border-radius: var(--r-pill); font-size: .95rem; font-weight: 600; transition: transform .2s ease, box-shadow .2s ease, background-color .2s ease; }
  .rainbow-error__btn .icon { width: 1.05rem; height: 1.05rem; }
  .rainbow-error__btn--solid { background: #fff; color: #1d1d1f; }
  .rainbow-error__btn--solid:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(0, 0, 0, .25); }
  .rainbow-error__btn--ghost { background: rgba(255, 255, 255, .14); color: #fff; border: 1px solid rgba(255, 255, 255, .35); }
  .rainbow-error__btn--ghost:hover { background: rgba(255, 255, 255, .24); }
`;

export default async function ClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  const result = await getClip(id, user?.id);

  if (!result.ok) {
    if (result.reason === 'forbidden') {
      // 对齐 Flask：私有且非作者/非站长 → abort(403) → 全站统一 403 错误页。
      return (
        <>
          <style dangerouslySetInnerHTML={{ __html: forbiddenCss }} />
          <div className="rainbow-error">
            <div className="rainbow-error__bg" aria-hidden="true"></div>
            <div className="rainbow-error__box">
              <p className="rainbow-error__code">403</p>
              <h1 className="rainbow-error__title">禁止访问</h1>
              <p className="rainbow-error__msg">抱歉，您没有足够的权限访问此页面。</p>
              <p className="rainbow-error__hint">
                可能是该内容需要特定权限，或者您的账户尚未登录。登录后再试，或联系网站管理员。
              </p>
              <div className="rainbow-error__actions">
                <Link href="/login" className="rainbow-error__btn rainbow-error__btn--solid">
                  <span className="icon icon-person-circle"></span>去登录
                </Link>
                <Link href="/" className="rainbow-error__btn rainbow-error__btn--ghost">
                  <span className="icon icon-house"></span>返回首页
                </Link>
              </div>
            </div>
          </div>
          <FooterCopyright text="© 2026 聪明山. 迷路了也能找到回家的路。" />
        </>
      );
    }
    notFound();
  }

  const { clip } = result;
  const isAuthor = !!user && user.id === clip.authorId;
  const canDelete = isAuthor || isOwner(user);

  return (
    <div className="clipboard-page">
      <div className="clipboard-detail">
        <div className="clipboard-detail__header">
          <h1 className="clipboard-detail__header-title">{clip.title}</h1>
          <div className="clipboard-detail__header-meta">
            <span>作者：{clip.authorName ?? '未知作者'}</span>
            <span className="clipboard-detail__header-meta-id">
              ID：<code>{clip.id}</code>
              <ClipIdCopyButton text={clip.id} />
            </span>
          </div>
        </div>

        <div className="clipboard-detail__content">
          <ClipContent content={clip.content ?? ''} />
        </div>

        <ClipActions
          clipId={clip.id}
          content={clip.content ?? ''}
          isAuthor={isAuthor}
          canDelete={canDelete}
        />
      </div>
      {/* 对齐 Flask detail.html 覆写 copyright：页脚显示按作者署名的版权行 */}
      <FooterCopyright
        text={`原作者：${clip.authorName ?? '未知作者'} | 版权归原作者所有`}
      />
    </div>
  );
}
