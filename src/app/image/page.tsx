import { getCurrentUser, isOwner } from '@/lib/auth';
import { requireCoreUser } from '@/lib/guard';
import { listUserImages } from '@/lib/image-service';
import { getQuotaLimitMb, getUserUsedBytes } from '@/lib/image-upload';
import ImageUploader, { ImageGallery } from '@/app/components/ImageUploader';

export const dynamic = 'force-dynamic'; // 依赖登录态与个人数据，禁用静态化

export default async function ImageGalleryPage() {
  await requireCoreUser();
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="image-hosting-page">
        <div className="image-hosting-header">
          <h1 className="image-hosting-title">图床</h1>
          <p className="image-hosting-subtitle">上传图片，获取分享链接</p>
        </div>
        <div className="image-hosting-grid__empty">
          <p>请登录</p>
        </div>
      </div>
    );
  }

  const owner = isOwner(user);
  const images = await listUserImages(user.id);

  // 配额（对齐 Flask ImageService.get_user_quota）
  const usedBytes = await getUserUsedBytes(user.id);
  const limitMb = getQuotaLimitMb(user.role);
  const limitBytes = limitMb * 1024 * 1024;
  const usedMb = Math.round((usedBytes / (1024 * 1024)) * 100) / 100;
  const usagePercent = limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 100;

  return (
    <div className="image-hosting-page">
      <div className="image-hosting-header">
        <h1 className="image-hosting-title">图床</h1>
        <p className="image-hosting-subtitle">上传图片，获取分享链接</p>
        {/* owner 专属：管理所有图片。对齐 Flask image.admin（/image/admin 图床专属管理页）。 */}
        {owner && (
          <a className="button-warning-small" href="/image/admin" style={{ marginTop: 12, display: 'inline-block' }}>
            管理所有图片
          </a>
        )}
      </div>

      {/* Quota bar */}
      <div className="image-hosting-quota">
        <div className="image-hosting-quota__info">
          <span>已用 <strong>{usedMb} MB</strong> / {limitMb} MB</span>
          <span>{usagePercent}%</span>
        </div>
        <div className="image-hosting-quota__bar">
          <div
            className={`image-hosting-quota__fill${usagePercent > 80 ? ' image-hosting-quota__fill--warn' : ''}`}
            style={{ width: `${usagePercent}%` }}
          ></div>
        </div>
      </div>

      {/* 上传区（客户端组件，保持原有上传逻辑与组件边界） */}
      <ImageUploader />

      {/* 图片网格 + 预览模态框（客户端组件，复刻复制/删除/预览交互） */}
      <ImageGallery
        images={images.map((img) => ({ id: img.id, filename: img.filename, fileSize: img.fileSize }))}
        isOwner={owner}
      />
    </div>
  );
}
