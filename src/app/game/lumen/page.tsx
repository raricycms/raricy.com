import type { Metadata } from 'next';
import Lumen from '@/games/lumen/Lumen';

export const metadata: Metadata = {
  title: '折光 · 聪明山',
  description: '转动镜片，让光线反射、分流、交汇、穿过传送门。22 个循序渐进的光路谜题。',
};

export default function LumenPage() { return <Lumen />; }
