'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import { curveCss, type MotionCurve } from './curves';

// 试验台上的「下拉面板」—— 博客目录筛选条里「全部栏目」那个下拉的复刻件。
// 几何取近似值（闭宽 164px、高 36px、圆角 20px；站内真实件是 120px / 42px / 21px）：
// 这里比的是曲线，不是像素。
//
// 【为什么复制一份而不是直接用】站内真正的下拉（BlogCategorySelect / 通用 ExpandSelect）
// 把时长与曲线写死在样式表里（展开档 480ms / 收起档 220ms），因为那是**已经定下来的
// 站内取值**。试验台要的是「同一个组件、只换曲线」，所以这里保留外壳宽度增长、
// 面板 0fr → 1fr 按内容高度伸展、选项随后淡入这套结构，把节奏全部改成从
// `--mo-duration` / `--mo-easing` 读 —— 与展开面板、分段滑块那两格同一个口径。
//
// 内容用固定的栏目名（不是真的博客栏目）：五列必须结构完全一致，比较的才只是曲线。
// 点选项只在本组件内切换高亮并收起，不跳转、不发请求。
const ITEMS = ['全部栏目', '精选文章', '技术笔记', '生活随笔'] as const;

export default function TailDropdown({
  curve,
  duration,
  run,
}: {
  curve: MotionCurve;
  duration: number;
  run: number;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = `mo-cat-${useId().replace(/:/g, '')}`;

  // 重播不能换 key 重挂载（重挂载得到的是「收着」的初态，看到的是展开而不是「展开这一下」），
  // 所以和展开面板那一格一样走状态机：先收起，等收起那段真的走完再展开。
  // 收起方向用的是同一个 transition（同一时长），等待时间必须跟着 duration 走 ——
  // 固定等一个短值会在半收状态就反向，五列的起点就不一致了。
  useEffect(() => {
    if (run === 0) return;
    setOpen(false);
    const timer = setTimeout(() => setOpen(true), duration + 60);
    return () => clearTimeout(timer);
  }, [run, duration]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const style = {
    '--mo-duration': `${duration}ms`,
    '--mo-easing': curveCss(curve),
  } as CSSProperties;

  return (
    <div
      ref={host}
      className={`mo-cat${open ? ' is-open' : ''}`}
      style={style}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="mo-cat__shell">
        <button
          ref={toggle}
          type="button"
          className="mo-cat__toggle"
          aria-label={`栏目：${ITEMS[picked]}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{ITEMS[picked]}</span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div className="mo-cat__panel" id={panelId} inert={!open}>
          <div className="mo-cat__clip">
            <div className="mo-cat__options" aria-label="栏目">
              {ITEMS.map((item, index) => (
                <button
                  key={item}
                  type="button"
                  className={`mo-cat__option${index === picked ? ' is-active' : ''}`}
                  onClick={() => {
                    setPicked(index);
                    setOpen(false);
                    toggle.current?.focus();
                  }}
                >
                  <span>{item}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
