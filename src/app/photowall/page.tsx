import PhotoWall from '@/app/components/PhotoWall';
import { requireCoreUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '照片墙 - raricy.com',
};

export default async function PhotoWallPage() {
  await requireCoreUser();
  return (
    <div className="photo-wall" id="photo-wall-app">
      <PhotoWall />
    </div>
  );
}
