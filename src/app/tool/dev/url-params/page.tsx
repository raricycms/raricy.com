import type { Metadata } from 'next';
import DevToolShell from '@/app/tool/dev/DevToolShell';
import { devToolMetadata } from '@/lib/dev-tools/registry';
import UrlParamsTool from './UrlParamsTool';

export const metadata: Metadata = devToolMetadata('url-params');

export default function Page() {
  return (
    <DevToolShell slug="url-params">
      <UrlParamsTool />
    </DevToolShell>
  );
}
