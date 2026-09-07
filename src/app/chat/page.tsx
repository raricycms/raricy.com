import { cookies } from 'next/headers';
import { requireCoreUser } from '@/lib/guard';
import { hasAdminRights } from '@/lib/auth';
import { COOKIE_NAME } from '@/lib/chat-sidebar-pref';
import ChatApp from './ChatApp';

export const dynamic = 'force-dynamic';

interface SearchParams {
  channel?: string;
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCoreUser();
  const sp = await searchParams;
  // 侧栏折叠偏好镜像（cookie 只存 '1'=折叠）：首屏直出折叠态，避免水合后再折叠的布局跳变。
  const collapsedPref = (await cookies()).get(COOKIE_NAME)?.value === '1';
  return (
    <ChatApp
      currentUserId={user.id}
      isAdmin={hasAdminRights(user)}
      initialChannel={typeof sp.channel === 'string' && sp.channel ? sp.channel : null}
      initialSidebarCollapsed={collapsedPref}
    />
  );
}