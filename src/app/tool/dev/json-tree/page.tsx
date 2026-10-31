import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import JsonTreeTool from './JsonTreeTool';

export const metadata: Metadata = devToolMetadata('json-tree');

export default function Page() {
  return (
    <DevToolShell slug="json-tree">
      <JsonTreeTool />
    </DevToolShell>
  );
}
