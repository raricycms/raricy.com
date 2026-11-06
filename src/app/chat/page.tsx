import { cookies } from 'next/headers';
import { forbidden } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { isFocusLobbyBlocked } from '@/lib/focus-mode';
import { COOKIE_NAME } from '@/lib/chat-sidebar-pref';
import ChatApp from './ChatApp';

export const dynamic = 'force-dynamic';

interface SearchParams {
  channel?: string;
  /** 深链目标消息 id（来自「保存的消息」）；与 channel 一起才生效。 */
  message?: string;
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCoreUser();
  // 【禁言】页面必须与 /api/chat/* 同档（接口在禁言时连读都拦，见 api/chat/_auth.ts）。
  // 不拦的话：首个 poll 拿 403 → ChatApp 早退 → channelsLoaded 永假 → 两侧永久
  // 「加载中…」，用户看不到任何原因也没有出口。与保存箱同一做法（chat/saved/page.tsx）。
  if (isCurrentlyBanned(user)) forbidden();
  const sp = await searchParams;
  // 只接正整数；形态不对就当没传 —— 深链是「尽力跳过去」，不该因此 400 或报错。
  const rawMessage = typeof sp.message === 'string' ? sp.message : '';
  const initialMessage =
    /^[1-9][0-9]*$/.test(rawMessage) && Number.isSafeInteger(Number(rawMessage))
      ? Number(rawMessage)
      : null;
  // 侧栏折叠偏好镜像（cookie 只存 '1'=折叠）：首屏直出折叠态，避免水合后再折叠的布局跳变。
  const collapsedPref = (await cookies()).get(COOKIE_NAME)?.value === '1';
  return (
    <ChatApp
      currentUserId={user.id}
      currentUsername={user.username}
      isAdmin={hasAdminRights(user)}
      initialChannel={typeof sp.channel === 'string' && sp.channel ? sp.channel : null}
      initialMessage={initialMessage}
      initialSidebarCollapsed={collapsedPref}
      initialLobbyBlocked={isFocusLobbyBlocked(user)}
    />
  );
}