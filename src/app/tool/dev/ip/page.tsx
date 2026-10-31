import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import IpTool from './IpTool';

export const metadata: Metadata = devToolMetadata('ip');

export default function Page() {
  return (
    <DevToolShell slug="ip">
      <IpTool />
    </DevToolShell>
  );
}
