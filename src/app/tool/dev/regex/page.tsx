import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import RegexTool from './RegexTool';

export const metadata: Metadata = devToolMetadata('regex');

export default function Page() {
  return (
    <DevToolShell slug="regex">
      <RegexTool />
    </DevToolShell>
  );
}
