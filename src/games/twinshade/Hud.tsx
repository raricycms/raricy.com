// ─────────────────────────────────────────────────────────────────────────────
// Hud.tsx — 双影的抬头显示：返回、关卡身份、步数 / 星级、操作按钮、教学气泡、状态行
//
// 这是一个**纯受控**组件：所有数字与开关都从 props 来，所有操作都只调用回调。
// 它不 import engine、不判规则、不持有游戏状态 —— 唯一的本地状态是零个。
// 这样「走不动了」「通关了」这类判定只有容器一个出口，展示层不会自己算出第二套结论。
//
// 按钮只用 abstracts/_mixins.scss 的三档：主要行动 = btn-primary，其余 = btn-secondary
// （`--primary` / `--soft` / `--icon` 三个修饰符），不自创一套表面。
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  Grid3X3,
  Lightbulb,
  RotateCcw,
  Star,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { HudProps } from './ui-types';

/**
 * 三颗星里点亮前 `filled` 颗。
 * 点亮状态写在容器的 `data-stars` 上而不是逐个 svg 上：一颗星的「亮 / 灭」是同一条
 * 信息，交给 CSS 按 `nth-child(-n + n)` 一次算完，DOM 里就不必出现三个布尔属性。
 * `role="img"` + 中文 aria-label：读屏用户听到的是「预计 2 星」，而不是三个空 svg。
 */
function StarMeter({ filled, label }: { filled: number; label: string }) {
  return (
    <span className="tw-stars" data-stars={filled} role="img" aria-label={label}>
      {[1, 2, 3].map((i) => (
        <Star key={i} size={16} aria-hidden="true" />
      ))}
    </span>
  );
}

export default function Hud({
  backHref,
  backLabel,
  def,
  index,
  total,
  moves,
  par,
  stars,
  soundOn,
  canUndo,
  coach,
  status,
  cleared,
  onUndo,
  onRestart,
  onHint,
  onToggleSound,
  onOpenLevels,
  onDismissCoach,
}: HudProps) {
  return (
    <>
      <header className="tw-hud">
        <div className="tw-hud__back">
          <Link className="tw-btn tw-btn--soft" href={backHref}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{backLabel}</span>
          </Link>
        </div>

        <div className="tw-hud__title">
          <h1>双影</h1>
          {/* 关卡身份：序号 + 名字。`total` 放 title（悬停可见、读屏可作为补充信息），
              而不是塞进 chip 正文 —— 正文只留「第几关 · 叫什么」这一条必要信息。
              （不给 <p> 挂 aria-label：段落角色的命名是被 ARIA 禁止的，挂了也无效。） */}
          <p className="tw-hud__level" title={`共 ${total} 关`}>
            第 {index} 关 · {def.name}
            {def.teach ? <em>{def.teach}</em> : null}
          </p>
        </div>

        <div className="tw-hud__meta">
          <p className="tw-stat tw-stat--moves">
            <span className="tw-stat__label">步数</span>
            <span className="tw-stat__value numeric">{moves}</span>
            <span className="tw-stat__label">/ {par} 最优</span>
          </p>
          <StarMeter filled={stars} label={`当前预计 ${stars} 星`} />
        </div>

        <div className="tw-hud__actions">
          <button
            type="button"
            className="tw-btn tw-btn--soft"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="撤销上一步"
            title="撤销上一步"
          >
            <Undo2 size={16} aria-hidden="true" />
            <span>撤销</span>
          </button>
          <button
            type="button"
            className="tw-btn tw-btn--soft"
            onClick={onRestart}
            aria-label={cleared ? '重新挑战本关' : '重来本关'}
            title={cleared ? '已通关，重新挑战不覆盖更好的成绩' : '从头再走一遍'}
          >
            <RotateCcw size={16} aria-hidden="true" />
            <span>{cleared ? '重新挑战' : '重来'}</span>
          </button>
          <button
            type="button"
            className="tw-btn tw-btn--soft tw-btn--icon"
            onClick={onHint}
            aria-label="显示提示"
            title="显示提示"
          >
            <Lightbulb size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="tw-btn tw-btn--soft tw-btn--icon"
            onClick={onOpenLevels}
            aria-label="选择关卡"
            title="选择关卡"
          >
            <Grid3X3 size={18} aria-hidden="true" />
          </button>
          {/* 声音是「开 / 关」二态，用 aria-pressed 表达当前状态；名字随状态变，
              读屏用户点之前就知道按下去会发生什么。 */}
          <button
            type="button"
            className="tw-btn tw-btn--soft tw-btn--icon"
            onClick={onToggleSound}
            aria-label={soundOn ? '关闭音效' : '开启音效'}
            aria-pressed={soundOn}
            title={soundOn ? '关闭音效' : '开启音效'}
          >
            {soundOn ? (
              <Volume2 size={18} aria-hidden="true" />
            ) : (
              <VolumeX size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {/* 教学气泡只在有文案时占位：空壳会凭空多出一段留白（站点 `p + p` 那条教训）。 */}
      {coach ? (
        <div className="tw-coach">
          <p>{coach}</p>
          <button type="button" className="tw-btn tw-btn--soft" onClick={onDismissCoach}>
            知道了
          </button>
        </div>
      ) : null}

      {/* 状态行是「走不动了 / 通关了」唯一的文字出口，所以它是 live region：
          内容一变读屏就会念出来，不需要玩家去找哪个数字变了。 */}
      <p className="tw-status" role="status" aria-live="polite" data-tone={status.tone}>
        {status.text}
      </p>
    </>
  );
}
