import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth';
import { redirectToLogin } from '@/lib/guard';
import WandDemo from '@/games/wand/WandDemo';

export const metadata: Metadata = { title: 'Wand demo · 聪明山' };

export default async function WandPage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin('/game/wand');
  return <WandDemo />;
}
