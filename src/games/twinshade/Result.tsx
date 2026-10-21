// ─────────────────────────────────────────────────────────────────────────────
// Result.tsx — 通关浮层
//
// 只展示容器算好的结果（步数 / 星数 / 是不是最后一关），不重新判规则。
// 星级的「依次点亮」是纯 CSS 动画（`--tw-star-delay` 逐颗错开），README 的动画纪律
// 明确不许 JS 逐帧；DOM 里星是同时挂上去的，错开只发生在 CSS 里。
//
// 这个浮层没有「关闭」按钮：通关之后必须选一条路（下一关 / 重玩 / 关卡选择），
// 点遮罩也关不掉 —— 关掉它就停在一个「已经通关但界面还是通关前」的状态里，
// 那是最容易让人以为游戏卡死的一种空转。
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { Star } from 'lucide-react';
import type { ResultProps } from './ui-types';

export default function Result({
  open,
  def,
  moves,
  par,
  stars,
  isLast,
  onNext,
  onReplay,
  onLevels,
}: ResultProps) {
  if (!open) return null;

  return (
    <div
      className="tw-result"
      data-stars={stars}
      role="dialog"
      aria-modal="true"
      aria-label={isLast ? '全部通关' : `通关：${def.name}`}
    >
      <div className="tw-result__panel">
        <h2>{isLast ? '全部通关' : `通关 · ${def.name}`}</h2>

        <div className="tw-result__stars" role="img" aria-label={`${stars} 星`}>
          {[1, 2, 3].map((i) => (
            <Star key={i} size={40} aria-hidden="true" />
          ))}
        </div>

        <dl className="tw-result__stats">
          <div>
            <dt>步数</dt>
            <dd className="numeric">{moves}</dd>
          </div>
          <div>
            <dt>最优</dt>
            <dd className="numeric">{par}</dd>
          </div>
        </dl>

        <div className="tw-result__actions">
          {isLast ? null : (
            <button type="button" className="tw-btn tw-btn--primary" onClick={onNext}>
              下一关
            </button>
          )}
          <button type="button" className="tw-btn tw-btn--soft" onClick={onReplay}>
            重玩
          </button>
          <button type="button" className="tw-btn tw-btn--soft" onClick={onLevels}>
            关卡选择
          </button>
        </div>
      </div>
    </div>
  );
}
