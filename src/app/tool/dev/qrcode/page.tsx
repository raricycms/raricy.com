import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import QrTool from './QrTool';

export const metadata: Metadata = devToolMetadata('qrcode');

export default function Page() {
  return (
    <DevToolShell slug="qrcode">
      <QrTool />
    </DevToolShell>
  );
}
