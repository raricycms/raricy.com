import type { Metadata } from 'next';
import Loom from '@/games/craft/loom/Loom';

export const metadata: Metadata = {
  title: '小小织布机 · 聪明山',
  description: '选择经线配色，拖动梭子一行行织出小布块。可逐行换色、撤销与导出。',
};

export default function LoomPage() { return <Loom />; }
