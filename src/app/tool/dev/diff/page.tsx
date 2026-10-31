import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import DiffTool from './DiffTool';

export const metadata: Metadata = devToolMetadata('diff');

export default function Page() {
  return (
    <DevToolShell slug="diff">
      <DiffTool />
    </DevToolShell>
  );
}
