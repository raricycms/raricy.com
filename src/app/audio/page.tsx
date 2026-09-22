import { getCurrentUser, isOwner } from '@/lib/auth';
import { requireCoreUser } from '@/lib/guard';
import { getQuotaLimitMb } from '@/lib/image-upload';
import { getUserUsedAudioBytes, listUserAudio } from '@/lib/audio-service';
import AudioUploader, { AudioGallery } from '@/app/components/AudioUploader';
import { GuidePill } from '@/app/components/MarkdownGuide';

export const dynamic = 'force-dynamic';

// 音频床
//
// 与 /image 同构，两处刻意不同：
//   · 配额数与图床**各算各的**（getUserUsedAudioBytes 打的是 audio_hosting），
//     但额度值来自同一张 QUOTA_LIMITS_MB —— 「独立」指计量，不是另立一份数字表。
//   · 页面外壳复用 image-hosting-* 那套类名。它们是「媒体托管页」的骨架，
//     与图片本身无关；另起一套只会让两份样式各自漂。
export default async function AudioGalleryPage() {
  await requireCoreUser();
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="image-hosting-page">
        <div className="image-hosting-header">
          <h1 className="image-hosting-title">音频床</h1>
          <p className="image-hosting-subtitle">上传音频，获取分享链接</p>
        </div>
        <div className="image-hosting-grid">
          <div className="image-hosting-grid__empty">
            <p>请先登录</p>
          </div>
        </div>
      </div>
    );
  }

  const owner = isOwner(user);
  const items = await listUserAudio(user.id);

  const usedBytes = await getUserUsedAudioBytes(user.id);
  const limitMb = getQuotaLimitMb(user.role);
  const limitBytes = limitMb * 1024 * 1024;
  const usedMb = Math.round((usedBytes / (1024 * 1024)) * 100) / 100;
  const usagePercent =
    limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 100;

  return (
    <div className="image-hosting-page">
      <div className="image-hosting-header">
        <h1 className="image-hosting-title">音频床</h1>
        <p className="image-hosting-subtitle">上传音频，获取分享链接</p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--fd-space-3)',
            justifyContent: 'center',
            marginTop: 'var(--fd-space-3)',
          }}
        >
          <GuidePill href="/audio/guide" />
          {owner && (
            <a
              href="/audio/admin"
              style={{
                fontSize: '0.8125rem',
                color: 'var(--color-text-secondary)',
                textDecoration: 'none',
                alignSelf: 'center',
              }}
            >
              管理所有音频
            </a>
          )}
        </div>
      </div>

      <div className="image-hosting-quota">
        <div className="image-hosting-quota__info">
          <span>
            已用 <strong>{usedMb} MB</strong> / {limitMb} MB
          </span>
          <span>{usagePercent}%</span>
        </div>
        <div className="image-hosting-quota__bar">
          <div
            className={`image-hosting-quota__fill${
              usagePercent > 80 ? ' image-hosting-quota__fill--warn' : ''
            }`}
            style={{ width: `${usagePercent}%` }}
          ></div>
        </div>
      </div>

      <AudioUploader />

      <AudioGallery
        items={items.map((a) => ({
          id: a.id,
          filename: a.filename,
          fileSize: a.fileSize,
        }))}
      />
    </div>
  );
}
