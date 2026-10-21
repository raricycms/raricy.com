import type { Metadata } from 'next';
import TwinShade from '@/games/twinshade/TwinShade';

export const metadata: Metadata = {
  title: '双影 · 聪明山',
  description: '一次操作，两个身体：让本体与影子各自踩上一盏灯。',
};

export default function TwinShadePage() {
  return <TwinShade backHref="/game" backLabel="返回玩具" />;
}
