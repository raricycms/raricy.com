import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'URL 编码 / 解码 - 聪明山工具箱',
  description: 'URL 百分号编码与解码，支持 encodeURI / encodeURIComponent 与空格加号等选项。',
};

export default function UrlToolLayout({ children }: { children: ReactNode }) {
  return children;
}
