import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import HttpStatusTool from './HttpStatusTool';

export const metadata: Metadata = devToolMetadata('http-status');

export default function Page() {
  return (
    <DevToolShell slug="http-status">
      <HttpStatusTool />
    </DevToolShell>
  );
}
