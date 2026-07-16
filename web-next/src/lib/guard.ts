import { forbidden } from 'next/navigation';
import { getCurrentUser, isCoreUser, type SafeUser } from './auth';

// 对齐原站 @authenticated_required：需登录 + 核心用户（core 及以上）。
// 原站对非核心用户 abort(403)——这里用 forbidden() 在原地以 403 状态渲染
// app/forbidden.tsx（彩虹 403 页），与原站行为一致（URL 不变、显示 403 页）。
export async function requireCoreUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!isCoreUser(user)) forbidden();
  return user!;
}
