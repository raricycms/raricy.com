import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import CubeTicTacToe from '@/app/components/CubeTicTacToe';

export const metadata = {
  title: '立方棋 · 聪明山',
};

export default function CubeTicTacToePage() {
  // 立方棋是沉浸式全屏页面（组件自身渲染 .cubettt-page，100vh + overflow: hidden），
  // 不能走 GamePageShell（标题/介绍与全屏布局冲突）。
  // 返回链接用 .cubettt-back（position: fixed，悬浮在画面上方）。
  return (
    <>
      <Link href="/game" className="cubettt-back">
        <ArrowLeft aria-hidden="true" /> 返回玩具
      </Link>
      <CubeTicTacToe />
    </>
  );
}
