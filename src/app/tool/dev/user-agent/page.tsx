import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import UserAgentTool from './UserAgentTool';

export const metadata: Metadata = devToolMetadata('user-agent');

export default function Page() {
  return (
    <DevToolShell slug="user-agent">
      <UserAgentTool />
    </DevToolShell>
  );
}
