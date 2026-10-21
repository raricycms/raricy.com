// ─────────────────────────────────────────────────────────────────────────────
// LevelSelect.tsx — 关卡选择浮层（按章节分组）
//
// 关卡列表与成绩都从 props 来：`levels` 是关卡定义、`best` 是「历史最好步数」表。
// 星级由 progress.ts 的 `starsFor(best, par)` 现算 —— 存档里只存步数，不存星数：
// 星数是**规则**的产物，将来调宽 / 调严分档时，老存档的星会跟着规则一起变，
// 而不是留下一批按旧规则算出的「化石星」。
//
// 打开 / 关闭由 props 控制（open），Esc 由容器统一处理 —— 这里不重复绑键盘事件，
// 否则两层各关一次会把状态关乱。
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { Star, X } from 'lucide-react';
import type { LevelDef } from './types';
import type { LevelSelectProps } from './ui-types';
import { starsFor } from './progress';

/** 章节名用汉字数词（关卡作者就是按「第一章」这个说法组织的）。超过六章退回阿拉伯数字。 */
const ACT_NUMERALS = ['一', '二', '三', '四', '五', '六'];

function actTitle(act: number): string {
  const numeral = ACT_NUMERALS[act - 1];
  return numeral ? `第${numeral}章` : `第 ${act} 章`;
}

/** 三颗星，点亮前 `filled` 颗。纯装饰（读屏读按钮的 aria-label），故整体 aria-hidden。 */
function StarRow({ filled }: { filled: number }) {
  return (
    <span className="tw-stars" data-stars={filled} aria-hidden="true">
      {[1, 2, 3].map((i) => (
        <Star key={i} size={14} />
      ))}
    </span>
  );
}

interface ActGroup {
  act: number;
  /** `index` 是全局序号（1 起），与 HUD 的「第 N 关」同一个编号。 */
  entries: { def: LevelDef; index: number }[];
}

export default function LevelSelect({
  open,
  levels,
  currentId,
  best,
  onSelect,
  onClose,
}: LevelSelectProps) {
  if (!open) return null;

  // 按出现顺序分组（不按 act 排序）：关卡数组本身就是章节顺序，重排只会让
  // 「关卡 12 在第一章后面」这种直觉失效。
  const groups: ActGroup[] = [];
  levels.forEach((def, i) => {
    const last = groups[groups.length - 1];
    const entry = { def, index: i + 1 };
    if (last && last.act === def.act) last.entries.push(entry);
    else groups.push({ act: def.act, entries: [entry] });
  });

  return (
    <div
      className="tw-levels"
      role="dialog"
      aria-modal="true"
      aria-label="选择关卡"
      // 点遮罩关闭：只在事件落在遮罩自身时关。面板上的点击会冒泡到这里，
      // 但 target 不是遮罩，于是不会被误判成「点外面」。
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="tw-levels__panel">
        <div className="tw-levels__head">
          <h2>关卡选择</h2>
          <button
            type="button"
            className="tw-btn tw-btn--soft tw-btn--icon"
            onClick={onClose}
            aria-label="关闭关卡选择"
            title="关闭"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {groups.map((group) => (
          <section key={group.act} className="tw-act" aria-label={actTitle(group.act)}>
            <h3>
              {actTitle(group.act)}
              <span> · {group.entries.length} 关</span>
            </h3>
            {group.entries.map(({ def, index }) => {
              const bestSteps: number | undefined = best[def.id];
              const earned = bestSteps === undefined ? 0 : starsFor(bestSteps, def.par);
              const isCurrent = def.id === currentId;
              const className = [
                'tw-level-item',
                isCurrent ? 'tw-level-item--current' : '',
                bestSteps !== undefined ? 'tw-level-item--done' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={def.id}
                  type="button"
                  className={className}
                  data-level-id={def.id}
                  aria-current={isCurrent ? 'true' : undefined}
                  aria-label={`第 ${index} 关 ${def.name}${
                    bestSteps !== undefined ? `，最好 ${bestSteps} 步，${earned} 星` : '，未通关'
                  }`}
                  onClick={() => onSelect(def.id)}
                >
                  <span className="tw-level-item__no">第 {index} 关</span>
                  <span className="tw-level-item__name">{def.name}</span>
                  <StarRow filled={earned} />
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
