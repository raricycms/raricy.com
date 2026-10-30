import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Base 编码 / 解码 - 聪明山工具箱',
  description: 'Base16 / 32 / 36 / 58 / 62 / 64 / 85 / 91 / 92 文本编解码，浏览器本地完成。',
};

export default function BaseToolLayout({ children }: { children: ReactNode }) {
  return children;
}
