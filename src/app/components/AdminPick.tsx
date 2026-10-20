'use client';

import { Check } from 'lucide-react';

// 管理端的圆形勾选点。
//
// 原生 <input type="checkbox"> 视觉隐藏但**仍在无障碍树与焦点序列里**（不是
// display:none / hidden —— 那会让键盘用户彻底够不到它），可见的是 sibling 那枚
// 22px 圆点：未选中为内容底色，选中转品牌实底 + 白色对勾；对勾用 transform/opacity
// 入场，和行卡底色同一节奏。
//
// 之所以不直接用全局 .form-check-input：那个控件只有 16px、选中只是换底色、没有
// 对勾，且它被注册页 / 工具页共用，改它会牵动一片无关页面。
export default function AdminPick({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 无障碍名称（这个控件外层没有可见文字标签）。 */
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="admin-pick" title={label}>
      <input
        type="checkbox"
        className="admin-pick__input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="admin-pick__box" aria-hidden="true">
        <Check strokeWidth={3} />
      </span>
    </label>
  );
}
