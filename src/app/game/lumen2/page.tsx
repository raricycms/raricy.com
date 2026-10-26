import type { Metadata } from 'next';
import Lumen2 from '@/games/lumen2/Lumen2';

export const metadata: Metadata = {
  title: '折光 2 · 聪明山',
  description: '有限的镜片，两束相互牵制的光。12 道关于放置、留空与共用的光路谜题，不计步数，只看解法。',
};

export default function Lumen2Page() { return <Lumen2 />; }
