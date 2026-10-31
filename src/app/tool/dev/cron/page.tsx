import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import CronTool from './CronTool';

export const metadata: Metadata = devToolMetadata('cron');

export default function Page() {
  return (
    <DevToolShell slug="cron">
      <CronTool />
    </DevToolShell>
  );
}
