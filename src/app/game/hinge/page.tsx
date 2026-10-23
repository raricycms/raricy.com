import type { Metadata } from 'next';
import Hinge from '@/games/hinge/Hinge';

export const metadata: Metadata = {
  title: '合页 Demo · 聪明山',
  description: '滑动、转动承载房间的纸片，改变门之间的连接。五个练习与一张从开局就能尝试的主谜题。',
};

export default function HingePage() { return <Hinge />; }
