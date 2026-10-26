import type { Metadata } from 'next';
import Hinge3 from '@/games/hinge3/Hinge3';

export const metadata: Metadata = {
  title: '合页 Demo 3 · 聪明山',
  description: '折起一张双面纸，让湿墨留下真正的镜像印痕。五道关于转印方向、镂空与纸张正反面的谜题。',
};
export default function Hinge3Page() { return <Hinge3 />; }
