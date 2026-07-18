import PhotoWall from '@/app/components/PhotoWall';
import { requireCoreUser } from '@/lib/guard';

export const dynamic = 'force-dynamic'; // 随贴图状态变化，禁用静态化

export const metadata = {
  title: '照片墙 - raricy.com',
};

// 服务端只渲染 .photo-wall 外壳；全部拖拽/旋转/缩放/平移/缩放视口等交互
// 由客户端组件 <PhotoWall /> 接管（忠实移植自 app/templates/photowall/wall.html）。
export default async function PhotoWallPage() {
  await requireCoreUser();
  return (
    <div className="photo-wall" id="photo-wall-app">
      <PhotoWall />
    </div>
  );
}
