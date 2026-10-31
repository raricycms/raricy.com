import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import UtmTool from './UtmTool';

export const metadata: Metadata = devToolMetadata('utm');

export default function Page() {
  return (
    <DevToolShell slug="utm">
      <UtmTool />
    </DevToolShell>
  );
}
