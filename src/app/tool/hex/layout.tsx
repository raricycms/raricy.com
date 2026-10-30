import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Hex 查看 / 编辑 - 聪明山工具箱',
  description: '在浏览器里查看、编辑并下载二进制文件的 Hex 视图，文件不上传。',
};

export default function HexToolLayout({ children }: { children: ReactNode }) {
  return children;
}
