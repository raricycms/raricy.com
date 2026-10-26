'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, Volume2, VolumeX } from 'lucide-react';
import { useCraftSound } from './sound';

/**
 * 手工间三款游戏共用的外框。
 *
 * 为什么要有一个共用的壳：三页的标题栏、返回钮、静音钮、工作区/侧栏两栏比例、
 * 以及"标题 + 一行状态"的排版必须**一模一样**，否则从织布机切到剪纸时页面会跳一下，
 * 而这正是"同一个房间里的三样手工"最不该有的感觉。样式在 _craft.scss 的 .craft-*。
 *
 * 壳只负责外框与排版，台面和手势各归各的游戏 —— 别往这里加任何单款游戏的东西。
 *
 * @param gameClass  根元素上的游戏类名（loom-game / paper-game / marbling-game），
 *                   样式分文件靠它作用域，e2e 也靠它定位。
 * @param attrs      根元素上的 data-* 钩子（e2e 只认这些，别改名字不打招呼）。
 * @param workspace  左侧工作区正文。
 * @param sidebar    右侧面板列（通常是几个 <CraftPanel>）。
 */
export function CraftHull({
  icon,
  title,
  gameClass,
  attrs,
  workspace,
  sidebar,
}: {
  icon: ReactNode;
  title: string;
  gameClass: string;
  attrs?: Record<string, string | number | boolean>;
  workspace: ReactNode;
  sidebar: ReactNode;
}) {
  const sound = useCraftSound();

  return (
    <div className={`container craft-game ${gameClass}`} {...attrs}>
      <header className="craft-header">
        <div className="craft-title">
          <Link className="craft-icon-button" href="/game/collections/test/craft" aria-label="返回手工间">
            <ArrowLeft size={20} />
          </Link>
          <span className="craft-logo">{icon}</span>
          <h1>
            {title}
            <small>手工间</small>
          </h1>
        </div>
        <div className="craft-actions">
          <button
            type="button"
            className="craft-icon-button"
            onClick={sound.toggle}
            aria-label={sound.muted ? '开启音效' : '关闭音效'}
          >
            {sound.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
        </div>
      </header>

      <div className="craft-layout">
        <section className="craft-workspace">{workspace}</section>
        <aside className="craft-sidebar">{sidebar}</aside>
      </div>
    </div>
  );
}

/** 侧栏里的一格面板。 */
export function CraftPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="craft-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
