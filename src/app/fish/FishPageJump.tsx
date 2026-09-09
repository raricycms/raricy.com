'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// 小鱼干流水分页跳转 — 与博客/通知同款（原 fd-* 类名全站无定义，按钮/输入框是裸的）
export default function FishPageJump({
  totalPages,
  current,
}: {
  totalPages: number;
  current: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState('');

  function jump() {
    let page = parseInt(value, 10);
    if (Number.isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(page));
    router.push(`?${params.toString()}`);
  }

  return (
    <span className="page-jump">
      <input
        type="number"
        min={1}
        max={totalPages}
        placeholder={String(current)}
        className="page-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {/* page-link 提供外观（与相邻页码同款），page-btn 只补 cursor/margin */}
      <button type="button" onClick={jump} className="page-link page-btn">
        跳转
      </button>
    </span>
  );
}
