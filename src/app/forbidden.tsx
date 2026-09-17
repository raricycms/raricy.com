import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';

// 403 禁止访问页 —— 逐节点还原原 errorhandlers/403.html（彩虹渐变 + 色相循环）。
// 由 forbidden()（受控页非核心用户）在原地以 403 状态渲染。
//
// 【按登录态分支】能走到这里的**基本都是已登录用户**：所有 guard 在未登录时都先
// redirect 到 /login（见 lib/guard.ts、admin/layout.tsx），forbidden() 只留给
// 「登录了但角色不够」。所以不能再无脑劝人「去登录」—— 对已登录的人那是个死循环
// （登录页会把他送回来）。已登录时只说明权限不足。
//
// 【这里曾经有个「换个账号」的 <Link href="/logout">，已删除】
// 那是个会自己触发的登出：Next 在生产环境会预取视口内的链接，而 GET /logout 这条路
// 由处理器做的事就是清会话 —— 于是「看一眼 403 页」=「被静默登出」。用户上报的
// 「会自动退登」就是这个。现在登出只认 POST（见 /api/auth/logout），别再往这里
// 放任何指向登出端点的链接；真要换账号，用户自己走顶栏的「退出登录」。
export default async function Forbidden() {
  const user = await getCurrentUser();

  return (
    <>
      <div className="rainbow-error">
        <div className="rainbow-error__bg" aria-hidden="true"></div>
        <div className="rainbow-error__box">
          <p className="rainbow-error__code">403</p>
          <h1 className="rainbow-error__title">禁止访问</h1>
          <p className="rainbow-error__msg">抱歉，您没有足够的权限访问此页面。</p>
          <p className="rainbow-error__hint">
            {user
              ? `当前账号（${user.username}）没有访问此页面的权限。如需更高权限，请联系网站管理员。`
              : '可能是该内容需要特定权限，或者您的账户尚未登录。登录后再试，或联系网站管理员。'}
          </p>
          <div className="rainbow-error__actions">
            {user ? (
              <Link href="/" className="rainbow-error__btn rainbow-error__btn--solid">
                <span className="icon icon-house"></span>返回首页
              </Link>
            ) : (
              <>
                <Link href="/login" className="rainbow-error__btn rainbow-error__btn--solid">
                  <span className="icon icon-person-circle"></span>去登录
                </Link>
                <Link href="/" className="rainbow-error__btn rainbow-error__btn--ghost">
                  <span className="icon icon-house"></span>返回首页
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
