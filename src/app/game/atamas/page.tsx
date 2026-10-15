import type { Metadata } from 'next';
import Atamas from '@/games/atamas';

export const metadata: Metadata = {
  title: 'ATÅMAS · 聪明山',
  description: '在圆环上放置数字与加号，触发连锁合并。',
};

export default function AtamasPage() {
  return <Atamas initialLang="zh_CN" backHref="/game" backLabel="返回玩具" />;
}
