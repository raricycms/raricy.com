import type { Metadata } from 'next';
import MotionLab from '@/games/motion/MotionLab';

export const metadata: Metadata = {
  title: '动效试验台 · 聪明山',
  description: '仅作展示、不作定稿：同一段动画按不同速度曲线、时长与尾巴长度并排播放，用来挑全站动效要用的曲线。',
};

export default function MotionLabPage() {
  return <MotionLab />;
}
