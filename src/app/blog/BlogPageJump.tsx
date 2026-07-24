'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// 分页跳转输入框 — Flask BEM
export default function BlogPageJump({
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
      <button type="button" onClick={jump} className="page-btn">
        跳转
      </button>
    </span>
  );
}