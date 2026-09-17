import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireCoreUser } from '@/lib/guard';
import { listOwnFavorites } from '@/lib/favorite-service';
import FavoriteMenu from './FavoriteMenu';

// 我的收藏夹 —— 公开与私密**并列**展示（这是所有者视角，两者都是他自己的）。
//
// ⚠️ 私密那几行**不显示任何 ID**：私密收藏夹在库里 public_id 为 NULL，本来就没有
//    句柄可显示。这里也不写「ID 已隐藏」之类的话 —— 那会暗示它有个被藏起来的东西。
export const dynamic = 'force-dynamic';

export default async function FavoritePage() {
  const user = await requireCoreUser();
  const favorites = await listOwnFavorites(user.id);

  return (
    <div className="container" style={{ paddingTop: '2rem', paddingBottom: '2rem' }}>
      <h1 className="favorite-detail__title" style={{ marginBottom: '1.25rem' }}>
        我的收藏夹
      </h1>

      <FavoriteMenu
        favorites={favorites.map((f) => ({
          id: f.id,
          publicId: f.publicId,
          title: f.title,
          isPublic: f.isPublic,
          itemCount: f.itemCount,
        }))}
      />

      {/* 「去看文章」走 .read-btn（本页 FavoriteMenu 的六颗按钮用的就是它，博客详情页的
          「返回上页」也是）—— 原先是一行没有样式的裸链接，看着不像能点的东西。 */}
      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/blog" className="read-btn">
          <ArrowLeft aria-hidden="true" size={14} /> 去看文章
        </Link>
      </p>
    </div>
  );
}
