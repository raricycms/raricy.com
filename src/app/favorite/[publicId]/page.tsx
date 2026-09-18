import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getPublicFavorite } from '@/lib/favorite-service';
import FavoriteDetailActions from '../FavoriteDetailActions';

// 公开收藏夹的分享页（6 位句柄）。
//
// ⚠️ 需要 core+ 登录：整个博客区都是 core+ 的（/blog/[id] 也是），而这一页列出的正是
//    博客链接 —— 做一张「游客打不开」的二维码没有意义。站外机器人 / 爬虫走的是
//    /api/spider/favorites/:id，那条同样需 core+，两处档位一致。
//
// 解析走 getPublicFavorite（过 PUBLIC_FAVORITE_WHERE）：私密 / 不存在 / 已软删
// 三者同为一个 404 —— 这一页**永远不会**渲染出私密收藏夹，它连句柄都没有。
export const dynamic = 'force-dynamic';

export default async function FavoritePublicPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const user = await requireCoreUser();
  const { publicId } = await params;
  const res = await getPublicFavorite(publicId);
  if (!res.ok) notFound();

  const fav = res.favorite;
  // 这一页是只读的分享视图；作者自己来了就给一条回管理页的路。
  // 用用户名比对而不是往 getPublicFavorite 的返回值里加 userId ——
  // 那个函数的产物同时喂给 spider 路由（对外契约），往「公开」的结果里塞内部 id
  // 是在给下一个改动埋雷。
  const isMine = fav.authorName === user.username;

  return (
    <div className="container" style={{ paddingTop: '2rem', paddingBottom: '2rem' }}>
      <div className="favorite-detail__head">
        <h1 className="favorite-detail__title">{fav.title}</h1>
        <span className="favorite-badge favorite-badge--public">公开</span>
        {isMine && (
          <Link className="read-btn" href={`/favorite/mine/${fav.id}`}>
            管理
          </Link>
        )}
      </div>

      <div className="favorite-detail__meta">
        <span>共 {fav.items.length} 篇</span>
        {/* 句柄本身，就是粘进 `[@六位ID]` 引用的那一串（不是模板字符串，别加 `$`） */}
        {fav.publicId && <span className="favorite-handle">[@{fav.publicId}]</span>}
        <span>收藏者：{fav.authorName}</span>
      </div>

      <FavoriteDetailActions
        mode="public"
        id={fav.publicId ?? ''}
        isPublic
        publicId={fav.publicId}
        title={fav.title}
      />

      {fav.items.length === 0 ? (
        <div className="favorite-list__empty">这个收藏夹还是空的。</div>
      ) : (
        <div className="favorite-detail__items">
          {fav.items.map((item) => (
            <div className="favorite-detail__item" key={item.blogId}>
              <Link href={`/blog/${item.blogId}`}>{item.title}</Link>
            </div>
          ))}
        </div>
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/favorite">← 我的收藏夹</Link>
      </p>
    </div>
  );
}
