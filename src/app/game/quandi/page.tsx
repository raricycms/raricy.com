import type { Metadata } from 'next';
import { forbidden } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { redirectToLogin } from '@/lib/guard';
import { canPlayRealtime } from '@/lib/realtime-ticket-service';
import Quandi from '@/games/quandi/Quandi';

export const metadata: Metadata = { title: '圈地运动 · 聪明山' };

export default async function QuandiPage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin('/game/quandi');
  // 专注模式由 /game layout 显示设置入口；封禁账号在页面与启动接口同样拦截。
  if (!user.focusMode && !canPlayRealtime(user)) forbidden();
  return <Quandi />;
}
