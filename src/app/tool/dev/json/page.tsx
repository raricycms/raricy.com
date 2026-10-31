import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import JsonTool from './JsonTool';

export const metadata: Metadata = devToolMetadata('json');

export default function Page() {
  return (
    <DevToolShell slug="json">
      <JsonTool />
    </DevToolShell>
  );
}
