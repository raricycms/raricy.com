import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import SqlTool from './SqlTool';

export const metadata: Metadata = devToolMetadata('sql');

export default function Page() {
  return (
    <DevToolShell slug="sql">
      <SqlTool />
    </DevToolShell>
  );
}
