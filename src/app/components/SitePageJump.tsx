'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * 分页的「跳页」输入框 —— 由 `SitePager` 渲染，页面里别再各写一份。
 *
 * 【为什么读 useSearchParams 而不是由调用方传地址】跳页要**保留当前筛选**
 * （search / category / sort / filter / type …）。路由参数只有它自己看得全 ——
 * 手拼 `?page=N` 会把筛选整串吃掉，而症状只是「跳完页筛选没了」，不报错。
 * 页面那侧的翻页链接反过来用各自的 `href(n)`（它们本来就带着筛选拼），两边口径
 * 因此都是「只改 page」。
 *
 * 【必须是客户端组件】它要 router.push 才能软导航；放进 SitePager（服务端组件）
 * 里当子节点正是为了不让整块分页掉进客户端包。
 */
export default function SitePageJump({
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
        aria-label="跳转到页码"
        className="page-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') jump();
        }}
      />
      {/* page-link 提供外观（与相邻页码同款），page-btn 只补 cursor/margin —— 两个类缺一不可 */}
      <button type="button" onClick={jump} className="page-link page-btn">
        跳转
      </button>
    </span>
  );
}
