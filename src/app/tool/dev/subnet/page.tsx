import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import SubnetTool from './SubnetTool';

export const metadata: Metadata = devToolMetadata('subnet');

export default function Page() {
  return (
    <DevToolShell slug="subnet">
      <SubnetTool />
    </DevToolShell>
  );
}
