import { requireOwner } from '@/lib/guard';
import { listAllImages, getTotalStorageBytes } from '@/lib/image-service';
import ImageAdminTable, { type AdminImageRow } from '@/app/components/ImageAdminTable';

export const dynamic = 'force-dynamic'; // 依赖登录态与全站数据，禁用静态化

interface SearchParams {
  page?: string;
  search?: string;
}

// 图床管理页（站长专属），逐字对齐 Flask image_hosting/admin.html。
export default async function ImageAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireOwner(); // 对齐 Flask @owner_required

  const sp = await searchParams;
  const page = parseInt(sp.page || '1', 10);
  const search = (sp.search ?? '').trim() || null;

  const [data, totalBytes] = await Promise.all([
    listAllImages(Number.isNaN(page) ? 1 : page, search),
    getTotalStorageBytes(),
  ]);

  const totalMb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;

  const rows: AdminImageRow[] = data.images.map((img) => ({
    id: img.id,
    filename: img.filename,
    authorName: img.authorName,
    fileSize: img.fileSize,
    createdAt: img.createdAt ? img.createdAt.toISOString() : '',
  }));

  // 分页链接保留 search 查询参数
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    params.set('page', String(p));
    if (search) params.set('search', search);
    return `/image/admin?${params.toString()}`;
  };

  return (
    <div className="image-hosting-page">
      <div className="image-hosting-header">
        <h1 className="image-hosting-title">图床管理</h1>
        <p className="image-hosting-subtitle">
          总存储用量：<strong>{totalMb} MB</strong>
        </p>
      </div>

      <div className="image-hosting-admin-bar">
        <form className="image-hosting-admin-bar__search" method="get">
          <input
            type="text"
            name="search"
            placeholder="搜索用户名或文件名..."
            defaultValue={search ?? ''}
            className="image-hosting-admin-bar__input"
          />
          <button type="submit" className="button-primary-small">
            搜索
          </button>
          {search && (
            <a href="/image/admin" className="button-warning-small">
              清除
            </a>
          )}
        </form>
      </div>

      {rows.length > 0 ? (
        <>
          <ImageAdminTable images={rows} />

          {data.pages > 1 && (
            <div className="image-hosting-pagination">
              {Array.from({ length: data.pages }, (_, i) => i + 1).map((p) => (
                <a
                  key={p}
                  href={pageHref(p)}
                  className={`image-hosting-pagination__item${p === data.page ? ' active' : ''}`}
                >
                  {p}
                </a>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="image-hosting-grid__empty">
          <p>{search ? '没有匹配的图片' : '还没有任何上传'}</p>
        </div>
      )}
    </div>
  );
}
