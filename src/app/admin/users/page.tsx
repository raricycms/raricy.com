import Link from 'next/link';
import { Ban, Megaphone, Search, Users } from 'lucide-react';
import { getCurrentUser, hasAdminRights, isOwner } from '@/lib/auth';
import { listUsers } from '@/lib/admin-user-service';
import Avatar from '@/app/components/Avatar';
import AdminEmpty from '@/app/components/AdminEmpty';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminPager from '@/app/components/AdminPager';
import AdminUserActions from '@/app/components/AdminUserActions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  search?: string;
}

// 角色徽标：类名（颜色档）与中文名分开放着，卡片里直接拼类名。
// 四档的色值全在 pages/admin/_users.scss 里，走主题令牌，暗色自动跟随。
const ROLE_META: Record<string, { cls: string; label: string }> = {
  owner: { cls: 'user-card__role--owner', label: '站长' },
  admin: { cls: 'user-card__role--admin', label: '管理员' },
  core: { cls: 'user-card__role--core', label: '核心用户' },
  user: { cls: 'user-card__role--user', label: '普通用户' },
};

type UserRow = {
  id: string;
  username: string;
  role: string;
  currentlyBanned: boolean;
  /** 头像框贴图地址（AdminUserRow.frameUrl）。 */
  frameUrl: string | null;
};

// 用户管理
//
// 【两个档位，同一页】core+ 就能进，但核心用户看到的是
// **只读**版本 —— 标题「用户列表」、副标题「查看注册用户」，且不渲染禁言 / 解除禁言 /
// 发通知 / 角色按钮（那些按钮各自另有 admin / owner 门控，只对够档的人渲染）。
// 别再往这里加「反正后端会挡」的动作按钮：按钮点了弹 403 对用户就是坏掉的界面。
//
// 版式沿用 /admin 与 /admin/blogs 的新设计语言：抬头走 AdminPageHeader，
// 搜索条是吸顶的 .admin-toolbar 胶囊，列表装在一张 .admin-panel 里，
// 分页走共用的 AdminPager（别再手写 <ul class="pagination">）。
// 用户卡本身仍是 .user-card 那一族 —— tests/e2e 的用例按类名与角色文字定位。
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser();
  const owner = isOwner(me);
  const canManage = hasAdminRights(me);

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

  // 搜索词原样回填，翻页 / 清除后仍留在框里 —— 与博客目录页同一套 GET 语义。
  const search = sp.search ?? '';

  return (
    <>
      <AdminPageHeader
        eyebrow={
          <>
            <Users aria-hidden="true" />
            人员
          </>
        }
        title={canManage ? '用户管理' : '用户列表'}
        subtitle={canManage ? '管理用户角色、禁言与通知' : '查看注册用户'}
        actions={
          owner ? (
            <Link href="/admin/broadcast" className="btn btn-primary">
              <Megaphone aria-hidden="true" />
              通知发送中心
            </Link>
          ) : undefined
        }
      />

      <div className="admin-container">
        {/* 搜索条：原生 GET 表单，提交即由服务端重渲染。控件几何与筛选页共用
            .admin-toolbar（吸顶、胶囊、控件统一高 44px）。 */}
        <form method="GET" className="admin-toolbar">
          <label className="admin-search">
            <span className="admin-search__icon" aria-hidden="true">
              <Search />
            </span>
            <input
              type="search"
              className="admin-search__input"
              name="search"
              defaultValue={search}
              placeholder="搜索用户名..."
              aria-label="搜索用户名"
            />
          </label>

          <button type="submit" className="btn btn-primary admin-toolbar__button">
            搜索
          </button>
          {search && (
            <Link href="/admin/users" className="btn btn-secondary admin-toolbar__button">
              清除
            </Link>
          )}

          <span className="admin-toolbar__hint">
            共 <span className="numeric">{result.total}</span> 位用户
          </span>
        </form>

        <section className="admin-panel" aria-labelledby="admin-users-title">
          <div className="admin-section-head">
            <h2 className="admin-section-title" id="admin-users-title">
              用户列表
            </h2>
            <span className="admin-section-count">
              本页 <span className="numeric">{result.users.length}</span> 位
            </span>
          </div>

          {(result.users as UserRow[]).length === 0 ? (
            <AdminEmpty
              icon={Users}
              title={search ? '没有找到匹配的用户' : '暂无用户'}
              description={search ? '换一个用户名再搜，或清掉搜索条件。' : undefined}
            >
              {search ? (
                <Link href="/admin/users" className="btn btn-primary">
                  清除搜索
                </Link>
              ) : null}
            </AdminEmpty>
          ) : (
            <div className="user-grid">
              {(result.users as UserRow[]).map((u) => {
                const role = ROLE_META[u.role] ?? ROLE_META.user;
                const displayRole = u.role === 'owner' ? ROLE_META.owner : role;
                return (
                  <div key={u.id} className="user-card">
                    <div className="user-card__top">
                      <Avatar
                        userId={u.id}
                        frameUrl={u.frameUrl}
                        alt={u.username}
                        imgClassName="user-card__avatar"
                      />
                      <div className="user-card__ident">
                        <span className="user-card__username">{u.username}</span>
                        <span className={`user-card__role ${displayRole.cls}`}>
                          {displayRole.label}
                        </span>
                        {u.currentlyBanned && (
                          // 禁言态沿用改版前的琥珀档（不是 owner/admin 那一枚红）：
                          // 它表达的是「受限」，与角色档位的红不是同一种含义。
                          <span className="admin-chip admin-chip--amber">
                            <Ban aria-hidden="true" />
                            禁言中
                          </span>
                        )}
                      </div>
                    </div>

                    <AdminUserActions
                      user={{
                        id: u.id,
                        username: u.username,
                        role: u.role,
                        currentlyBanned: u.currentlyBanned,
                      }}
                      isOwner={owner}
                      canManage={canManage}
                      currentUserId={me!.id}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <AdminPager page={result.page} pages={result.pages} href={qs} />
      </div>
    </>
  );
}
