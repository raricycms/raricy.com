import type { Metadata } from 'next';
import DevToolsHub from './DevToolsHub';
import { DEV_TOOLS } from '@/lib/dev-tools/registry';

export const metadata: Metadata = {
  title: '开发者工具合集 - 聪明山工具箱',
  description:
    'JSON 格式化与树形查看、JSON 路径查询、正则测试、SQL / 代码格式化、文本 Diff、Cron、时间戳、JWT、UUID、二维码、条码、URL、IP、子网、DNS 与响应头查询等开发者工具。',
};

export default function DevToolsPage() {
  return <DevToolsHub total={DEV_TOOLS.length} />;
}
