import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Quoted-Printable 编 / 解码 - 聪明山工具箱',
  description: '邮件 MIME 的 Quoted-Printable 编码与解码，支持软换行与行尾空白处理。',
};

export default function QpToolLayout({ children }: { children: ReactNode }) {
  return children;
}
