import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'HTML 实体编码 / 解码 - 聪明山工具箱',
  description: 'HTML 实体转义与还原，支持命名实体、数字实体与非 ASCII 字符。',
};

export default function HtmlToolLayout({ children }: { children: ReactNode }) {
  return children;
}
