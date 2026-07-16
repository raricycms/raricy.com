'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 对齐原 homepage.html 的 {% block footer_text %}：
// 原站仅首页在页脚第一个 div（footer-links 之后）注入这段"智慧河"提示。
// 全局 Footer 由 layout 渲染、不接收 children，故首页通过 portal 把内容注入到
// 页脚第一个内层 div 的末尾——与原站 DOM 位置逐字一致，且仅首页可见。
export default function HomeFooterNote() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(
      '.site-footer .footer-inner > div:first-child'
    );
    setHost(el);
  }, []);

  if (!host) return null;

  return createPortal(
    <p className="muted">
      你是否正在找智慧河的网站？来<a href="https://zhh.raricy.com">这里</a>。
    </p>,
    host
  );
}
