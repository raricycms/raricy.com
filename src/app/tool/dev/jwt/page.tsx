import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import JwtTool from './JwtTool';

export const metadata: Metadata = devToolMetadata('jwt');

export default function Page() {
  return (
    <DevToolShell slug="jwt">
      <JwtTool />
    </DevToolShell>
  );
}
