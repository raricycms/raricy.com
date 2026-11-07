import type { Metadata } from 'next';
import DevToolsHub from './DevToolsHub';
import { DEV_TOOLS } from '@/lib/dev-tools/registry';

export const metadata: Metadata = {
  title: '开发者工具合集 - 聪明山工具箱',
  // 数量与清单同源（新增工具自动跟着变）；分类措辞是页面级文案，不逐项列 slug。
  description: `JSON / 正则 / SQL / 代码格式化、Diff、Cron、时间戳、JWT、UUID、二维码、条码、URL 与网络查询等 ${DEV_TOOLS.length} 项开发者工具。`,
};

export default function DevToolsPage() {
  return <DevToolsHub total={DEV_TOOLS.length} />;
}
