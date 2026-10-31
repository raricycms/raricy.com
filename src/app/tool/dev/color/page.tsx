import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import ColorTool from './ColorTool';

export const metadata: Metadata = devToolMetadata('color');

export default function Page() {
  return (
    <DevToolShell slug="color">
      <ColorTool />
    </DevToolShell>
  );
}
