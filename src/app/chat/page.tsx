import { requireCoreUser } from '@/lib/guard';
import { hasAdminRights } from '@/lib/auth';
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
  return (
    <ChatApp
      currentUserId={user.id}
      isAdmin={hasAdminRights(user)}
      initialChannel={typeof sp.channel === 'string' && sp.channel ? sp.channel : null}
    />
  );
}