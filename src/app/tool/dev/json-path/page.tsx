import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import JsonPathTool from './JsonPathTool';

export const metadata: Metadata = devToolMetadata('json-path');

export default function Page() {
  return (
    <DevToolShell slug="json-path">
      <JsonPathTool />
    </DevToolShell>
  );
}
