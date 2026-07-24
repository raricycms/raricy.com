'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// 小鱼干流水分页跳转 — Fluent Design
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
    <span className="fd-pagination__jump">
      <input
        type="number"
        min={1}
        max={totalPages}
        placeholder={String(current)}
        className="fd-pagination__jump-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="button" onClick={jump} className="fd-btn fd-btn--outline fd-btn--sm">
        跳转
      </button>
    </span>
  );
}
