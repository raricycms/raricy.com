'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// 通用页脚提示：对齐原 base.html 的 {% block footer_text %}——
// 该 block 内容渲染在 .site-footer 左栏（terms/privacy 链接之后）。
// 全局 Footer 由 layout 渲染且不接收 children，故各页通过 portal 把 footer_text
// 注入到页脚第一个内层 div 末尾，与原站 DOM 位置一致，且仅当前页可见。
// （与 HomeFooterNote 同一机制，抽为通用组件供 contact / valid_user 复用。）
export default function FooterNote({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(
      document.querySelector<HTMLElement>('.site-footer .footer-inner > div:first-child')
    );
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}
