import Link from 'next/link';
import type { ReactNode } from 'react';

interface GamePageShellProps {
  title: string;
  description?: string;
  /** 返回链接的 BEM 后缀，例如 'game-atamas-back' / 'connect4-back' / 'uttt-back' */
  backClass?: string;
  /** 顶部 hero 容器类名，例如 'game-atamas-page' / 'connect4-page' / 'uttt-page' */
  pageClass?: string;
  children: ReactNode;
}

// 游戏页通用壳 — 对齐 Flask 各游戏的 page 容器 + back 链接类。
// 每个游戏页面以 `<div class="container {pageClass}">` 起头，
// 顶部用 `<a class="{backClass}" href="/game">← 返回玩具</a>`，再放标题/描述/children。
export default function GamePageShell({
  title,
  description,
  backClass = 'game-2048-back',
  pageClass = 'game-2048-page',
  children,
}: GamePageShellProps) {
  return (
    <div className={`container ${pageClass}`}>
      <Link href="/game" className={backClass}>
        ← 返回玩具
      </Link>
      <h1 className="game-hero__title">{title}</h1>
      {description && <p className="game-hero__description">{description}</p>}
      {children}
    </div>
  );
}