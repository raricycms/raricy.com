import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: '哈希计算 - 聪明山工具箱',
  description: 'SHA-256 / SHA-1 / SHA-512 / MD5 与 HMAC 计算，支持文本与文件，浏览器本地完成。',
};

export default function HashToolLayout({ children }: { children: ReactNode }) {
  return children;
}
