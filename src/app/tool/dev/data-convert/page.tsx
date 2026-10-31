import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import DataConvertTool from './DataConvertTool';

export const metadata: Metadata = devToolMetadata('data-convert');

export default function Page() {
  return (
    <DevToolShell slug="data-convert">
      <DataConvertTool />
    </DevToolShell>
  );
}
