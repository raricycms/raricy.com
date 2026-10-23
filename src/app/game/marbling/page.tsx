import type { Metadata } from 'next';
import Marbling from '@/games/craft/marbling/Marbling';

export const metadata: Metadata = {
  title: '水面印花 · 聪明山',
  description: '滴入颜料，用针或梳子拖出纹理，再用纸吸起花纹。支持撤销与图片导出。',
};

export default function MarblingPage() { return <Marbling />; }
