import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth';
import { redirectToLogin } from '@/lib/guard';
import PublicSpaceDemo from '@/games/public-space/PublicSpaceDemo';

export const metadata: Metadata = { title: '公共空间 · 聪明山' };

export default async function PublicSpacePage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin('/game/public-space');
  return <PublicSpaceDemo userId={user.id} />;
}
