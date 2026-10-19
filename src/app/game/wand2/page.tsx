import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth';
import { redirectToLogin } from '@/lib/guard';
import WandDemo2 from '@/games/wand2/WandDemo2';

export const metadata: Metadata = { title: 'Wand demo 2 · 聪明山' };
export default async function Wand2Page() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin('/game/wand2');
  return <WandDemo2 />;
}
