import type { LocalUrlPolicy } from 'reactive-md/react';

// RMD requires the host to opt in to image loading. Export prefetch uses the same policy.
export function isAllowedReactiveImage(url: string): boolean {
  if (!url || url.length > 8192 || url.startsWith('#') || /[\u0000-\u0020\u007f\\]/.test(url)) return false;
  if (!url.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  try {
    const address = new URL(url, 'https://raricy.com');
    return (address.protocol === 'https:' || address.protocol === 'http:') &&
      !address.username && !address.password;
  } catch {
    return false;
  }
}

export const reactiveUrlPolicy: LocalUrlPolicy = (url, kind) => kind === 'link' || isAllowedReactiveImage(url);
