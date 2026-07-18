'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// 小鱼干流水分页跳转（对齐 fish_transactions.html 的 page-jump + jumpToPage）。
// 保留当前查询参数（含 type），仅覆盖 page，钳制到 [1, totalPages]。
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
      <button type="button" onClick={jump} className="page-link page-btn">
        跳转
      </button>
    </span>
  );
}
