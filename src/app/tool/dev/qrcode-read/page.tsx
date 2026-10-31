import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import QrReadTool from './QrReadTool';

export const metadata: Metadata = devToolMetadata('qrcode-read');

export default function Page() {
  return (
    <DevToolShell slug="qrcode-read">
      <QrReadTool />
    </DevToolShell>
  );
}
