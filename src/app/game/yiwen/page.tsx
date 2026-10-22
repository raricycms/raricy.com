import type { Metadata } from 'next';
import Yiwen from '@/games/yiwen/Yiwen';

export const metadata: Metadata = {
  title: '异文 Demo · 聪明山',
  description: '观察图形、组合符号，尝试读懂一套未知的语言。七张实验卡与一块铭牌。',
};

export default function YiwenPage() { return <Yiwen />; }
