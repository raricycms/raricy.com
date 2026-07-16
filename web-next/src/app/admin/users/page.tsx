import Link from 'next/link';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { listUsers } from '@/lib/admin-user-service';
import AdminUserActions from '@/app/components/AdminUserActions';

export const dynamic = 'force-dynamic'; // 依赖查询参数与登录态

interface SearchParams {
  page?: string;
  search?: string;
}

const ROLE_META: Record<string, { cls: string; label: string }> = {
  owner: { cls: 'user-card__role--owner', label: '站长' },
  admin: { cls: 'user-card__role--admin', label: '管理员' },
  core: { cls: 'user-card__role--core', label: '核心用户' },
  user: { cls: 'user-card__role--user', label: '普通用户' },
};

// 分页页码窗口（window-of-3），对齐 Flask management.html：
// 始终显示首尾页，当前页 ±3 显示页码，其余折叠为 …（null 表示省略号）。
function pageWindow(page: number, pages: number, window = 3): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || (p >= page - window && p <= page + window)) {
      out.push(p);
    } else if (p === page - window - 1 || p === page + window + 1) {
      out.push(null);
    }
  }
  return out;
}

// 用户管理：逐字对齐 Flask auth/management.html（卡片 + 头像 + 角色徽章 + 操作按钮 + 模态框）。
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser();
  const owner = isOwner(me);

  const result = await listUsers({
    page: parseInt(sp.page || '1', 10),
    search: sp.search ?? null,
  });

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (sp.search) p.set('search', sp.search);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  return (
    <>
      <section className="admin-hero">
        <h1>用户管理</h1>
        <p>管理用户角色、禁言与通知</p>
      </section>

      <div className="admin-container">
        <div className="management-card">
          <div className="management-card__head">
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>用户列表</h2>
            {owner && (
              <div>
                <Link href="/admin/broadcast" className="btn btn-primary">
                  通知发送中心
                </Link>
              </div>
            )}
          </div>

          <form method="GET" className="user-search-form">
            <input
              type="search"
              name="search"
              defaultValue={sp.search ?? ''}
              placeholder="搜索用户名..."
              className="user-search-input"
            />
            <button type="submit" className="btn btn-primary">
              搜索
            </button>
            {sp.search && (
              <Link href="/admin/users" className="btn btn-secondary">
                清除
              </Link>
            )}
          </form>

          <div className="user-grid">
            {result.users.map((u) => {
              const role = ROLE_META[u.role] ?? ROLE_META.user;
              const displayRole = u.role === 'owner' ? ROLE_META.owner : role;
              return (
                <div key={u.id} className="user-card">
                  <div className="user-card__top">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/avatar/${u.id}`}
                      alt={u.username}
                      className="user-card__avatar"
                    />
                    <span className="user-card__username">{u.username}</span>
                    <span className={`user-card__role ${displayRole.cls}`}>{displayRole.label}</span>
                    {u.currentlyBanned && (
                      <span className="user-card__role user-card__role--banned">禁言中</span>
                    )}
                  </div>

                  <AdminUserActions
                    user={{
                      id: u.id,
                      username: u.username,
                      role: u.role,
                      currentlyBanned: u.currentlyBanned,
                    }}
                    isOwner={owner}
                    currentUserId={me!.id}
                  />
                </div>
              );
            })}
          </div>

          {result.pages > 1 && (
            <div className="admin-pagination">
              <nav>
                <ul className="pagination">
                  {result.hasPrev && (
                    <li className="page-item">
                      <Link className="page-link" href={qs(result.page - 1)}>
                        上一页
                      </Link>
                    </li>
                  )}
                  {pageWindow(result.page, result.pages).map((p, i) =>
                    p === null ? (
                      <li key={`gap-${i}`} className="page-item disabled">
                        <span className="page-link">…</span>
                      </li>
                    ) : (
                      <li key={p} className={`page-item ${p === result.page ? 'active' : ''}`}>
                        {p === result.page ? (
                          <span className="page-link">{p}</span>
                        ) : (
                          <Link className="page-link" href={qs(p)}>
                            {p}
                          </Link>
                        )}
                      </li>
                    )
                  )}
                  {result.hasNext && (
                    <li className="page-item">
                      <Link className="page-link" href={qs(result.page + 1)}>
                        下一页
                      </Link>
                    </li>
                  )}
                </ul>
              </nav>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
