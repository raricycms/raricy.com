import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import MimeTool from './MimeTool';

export const metadata: Metadata = devToolMetadata('mime');

export default function Page() {
  return (
    <DevToolShell slug="mime">
      <MimeTool />
    </DevToolShell>
  );
}
