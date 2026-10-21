import type { Metadata } from 'next';
import { forbidden } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { redirectToLogin } from '@/lib/guard';
import { isFocusGamesBlocked } from '@/lib/focus-mode';
import { canPlayRealtime } from '@/lib/realtime-ticket-service';
import Quandi from '@/games/quandi/Quandi';

export const metadata: Metadata = { title: '圈地运动 · 聪明山' };

export default async function QuandiPage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin('/game/quandi');
  // 专注模式屏蔽玩具区时由 /game layout 显示设置入口；未被屏蔽则继续判封禁/实时资格。
  if (!isFocusGamesBlocked(user) && !canPlayRealtime(user)) forbidden();
  return <Quandi />;
}
