import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import CodeTool from './CodeTool';

export const metadata: Metadata = devToolMetadata('code');

export default function Page() {
  return (
    <DevToolShell slug="code">
      <CodeTool />
    </DevToolShell>
  );
}
