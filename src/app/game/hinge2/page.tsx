import type { Metadata } from 'next';
import Hinge2 from '@/games/hinge2/Hinge2';

export const metadata: Metadata = {
  title: '合页 Demo 2 · 聪明山',
  description: '转动整张纸页、走进镜中道路、沿折痕对折空间。四张可以改变道路的立体纸景。',
};

export default function Hinge2Page() { return <Hinge2 />; }
