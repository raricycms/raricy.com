import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import UuidTool from './UuidTool';

export const metadata: Metadata = devToolMetadata('uuid');

export default function Page() {
  return (
    <DevToolShell slug="uuid">
      <UuidTool />
    </DevToolShell>
  );
}
