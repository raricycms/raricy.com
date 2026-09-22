import { requireOwner } from '@/lib/guard';
import { getTotalAudioBytes, listAllAudio } from '@/lib/audio-service';
import { ymdhms } from '@/lib/format';
import AudioAdminTable, { type AdminAudioRow } from '@/app/components/AudioAdminTable';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  search?: string;
}

// 音频床管理页（站长专属）
//
// 与 /image/admin 同构。注意「总存储用量」这里是**音频那一份** ——
// 站点的真实磁盘占用要两边相加，运维口径见 admin-stats-service 的 getSiteStats。
export default async function AudioAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOwner();

  const sp = await searchParams;
  const page = parseInt(sp.page || '1', 10);
  const search = (sp.search ?? '').trim() || null;

  const [data, totalBytes] = await Promise.all([
    listAllAudio(Number.isNaN(page) ? 1 : page, search),
    getTotalAudioBytes(),
  ]);

  const totalMb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;

  const rows: AdminAudioRow[] = data.audio.map((a) => ({
    id: a.id,
    filename: a.filename,
    authorName: a.authorName,
    fileSize: a.fileSize,
    createdAt: ymdhms(a.createdAt) ?? '',
  }));

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    params.set('page', String(p));
    if (search) params.set('search', search);
    return `/audio/admin?${params.toString()}`;
  };

  return (
    <div className="image-hosting-page">
      <div className="image-hosting-header">
        <h1 className="image-hosting-title">音频床管理</h1>
        <p className="image-hosting-subtitle">
          音频总占用：<strong>{totalMb} MB</strong>
        </p>
      </div>

      <div className="image-hosting-admin-bar">
        <form method="get" className="image-hosting-admin-bar__search">
          <input
            type="text"
            name="search"
            placeholder="搜索用户名或文件名..."
            defaultValue={search ?? ''}
            className="image-hosting-admin-bar__input"
          />
          <button type="submit" className="image-hosting-card__btn">
            搜索
          </button>
          {search && (
            <a href="/audio/admin" className="image-hosting-card__btn">
              清除
            </a>
          )}
        </form>
      </div>

      {rows.length > 0 ? (
        <>
          <AudioAdminTable items={rows} />

          {data.pages > 1 && (
            <nav className="image-hosting-pagination" aria-label="分页">
              {Array.from({ length: data.pages }, (_, i) => i + 1).map((p) => (
                <a
                  key={p}
                  href={pageHref(p)}
                  className={`image-hosting-pagination__item${
                    p === data.page ? ' active' : ''
                  }`}
                  aria-current={p === data.page ? 'page' : undefined}
                >
                  {p}
                </a>
              ))}
            </nav>
          )}
        </>
      ) : (
        <div className="image-hosting-grid__empty">
          <p>{search ? '没有匹配的音频' : '还没有任何上传'}</p>
        </div>
      )}
    </div>
  );
}
