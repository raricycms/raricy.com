import type { Metadata } from 'next';
import PaperCut from '@/games/craft/papercut/PaperCut';

export const metadata: Metadata = {
  title: '剪纸窗花 · 聪明山',
  description: '在折好的纸上随手剪几刀，展开成对称窗花。支持两折、三折与透明底导出。',
};

export default function PaperCutPage() { return <PaperCut />; }
