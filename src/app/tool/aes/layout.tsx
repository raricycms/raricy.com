import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AES 加 / 解密 - 聪明山工具箱',
  description: 'AES-GCM / CBC / CTR 前端加解密，支持文本或十六进制密钥与自定义 IV/Nonce。',
};

export default function AesToolLayout({ children }: { children: ReactNode }) {
  return children;
}
