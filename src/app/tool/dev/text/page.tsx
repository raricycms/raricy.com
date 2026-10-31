import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import TextTool from './TextTool';

export const metadata: Metadata = devToolMetadata('text');

export default function Page() {
  return (
    <DevToolShell slug="text">
      <TextTool />
    </DevToolShell>
  );
}
