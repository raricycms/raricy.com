import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import TimestampTool from './TimestampTool';

export const metadata: Metadata = devToolMetadata('timestamp');

export default function Page() {
  return (
    <DevToolShell slug="timestamp">
      <TimestampTool />
    </DevToolShell>
  );
}
