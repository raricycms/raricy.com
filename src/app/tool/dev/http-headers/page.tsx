import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import HttpHeadersTool from './HttpHeadersTool';

export const metadata: Metadata = devToolMetadata('http-headers');

export default function Page() {
  return (
    <DevToolShell slug="http-headers">
      <HttpHeadersTool />
    </DevToolShell>
  );
}
