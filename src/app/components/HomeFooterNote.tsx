'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// 首页 footer 的额外文字 — 通过 portal 注入到 site-footer-left。
// 对齐 Flask homepage.html 的 {% block footer_text %} 模式。
export default function HomeFooterNote() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.site-footer .site-footer-left');
    setHost(el);
  }, []);

  if (!host) return null;

  return createPortal(
    <p className="u-text-muted" style={{ color: 'var(--color-text-secondary)' }}>
      你是否正在找智慧河的网站？来 <a href="https://zhh.raricy.com">这里</a>。
    </p>,
    host
  );
}