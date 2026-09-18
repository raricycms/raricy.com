import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getOwnFavorite } from '@/lib/favorite-service';
import FavoriteDetailActions from '../../FavoriteDetailActions';

// 所有者的收藏夹管理页（公开 / 私密都在这里）。
//
// ⚠️ 路由参数是**内部 UUID**，不是 6 位句柄：私密收藏夹在库里 public_id 为 NULL，
//    没有句柄可用，所以所有者视图只能按内部 id 走。UUID 不可枚举，因此即便哪条读取
//    路径漏判了所有权，也降级成「猜不到」而不是「越权读到别人的私密收藏夹」。
//
// 私密收藏夹在这个页面上**不渲染任何 ID**（下面的 publicId 分支自然为空）。
export const dynamic = 'force-dynamic';

export default async function FavoriteMineDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireCoreUser();
  const { id } = await params;
  const res = await getOwnFavorite(id, user.id);
  // 不存在 / 不是我的 —— 同一个 404，不确认存在性
  if (!res.ok) notFound();

  const fav = res.favorite;

  return (
    <div className="container" style={{ paddingTop: '2rem', paddingBottom: '2rem' }}>
      <div className="favorite-detail__head">
        <h1 className="favorite-detail__title">{fav.title}</h1>
        <span className={`favorite-badge favorite-badge--${fav.isPublic ? 'public' : 'private'}`}>
          {fav.isPublic ? '公开' : '私密'}
        </span>
      </div>

      <div className="favorite-detail__meta">
        <span>共 {fav.items.length} 篇</span>
        {/* 6 位句柄只对公开收藏夹出现 —— 私密收藏夹没有它，这格就整块不渲染。
            ⚠️ 不要在这里补一句「私密收藏夹 ID 不可见」之类的占位文案。
            这是 JSX 文本 + 表达式，不是模板字符串：写成 `[@${fav.publicId}]`
            会连那个 `$` 一起渲染出来。 */}
        {fav.isPublic && fav.publicId && (
          <span className="favorite-handle">[@{fav.publicId}]</span>
        )}
        <span>创建者：{fav.authorName}</span>
      </div>

      <FavoriteDetailActions
        mode="mine"
        id={fav.id}
        isPublic={fav.isPublic}
        publicId={fav.publicId}
        title={fav.title}
      />

      {fav.items.length === 0 ? (
        <div className="favorite-list__empty">
          这个收藏夹还是空的。去看文章时点左下角的黄色五角星就能把文章收进来。
        </div>
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
