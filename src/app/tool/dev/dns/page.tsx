import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import DnsTool from './DnsTool';

export const metadata: Metadata = devToolMetadata('dns');

export default function Page() {
  return (
    <DevToolShell slug="dns">
      <DnsTool />
    </DevToolShell>
  );
}
