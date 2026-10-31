import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import BarcodeTool from './BarcodeTool';

export const metadata: Metadata = devToolMetadata('barcode');

export default function Page() {
  return (
    <DevToolShell slug="barcode">
      <BarcodeTool />
    </DevToolShell>
  );
}
