import { redirect } from 'next/navigation';

// /favorite/mine 本身没有内容 —— 存在的唯一理由是**占住这个静态段**。
//
// 没有它的话，`/favorite/mine` 会被 `/favorite/[publicId]` 匹配掉（把 "mine" 当成
// 一个公开 ID），用户看到的会是「收藏夹不存在」而不是自己的收藏夹列表。
export default function FavoriteMineIndexPage() {
  redirect('/favorite');
}
