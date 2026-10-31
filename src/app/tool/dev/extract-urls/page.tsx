import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import ExtractUrlsTool from './ExtractUrlsTool';

export const metadata: Metadata = devToolMetadata('extract-urls');

export default function Page() {
  return (
    <DevToolShell slug="extract-urls">
      <ExtractUrlsTool />
    </DevToolShell>
  );
}
