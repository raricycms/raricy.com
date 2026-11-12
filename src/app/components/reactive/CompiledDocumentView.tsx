'use client';

import 'reactive-md/screen.css';

import { useEffect, useState } from 'react';
import { createLocalRuntime, type LocalDocument, type LocalRuntime } from 'reactive-md';
import { LocalDocumentView, type LocalDocumentViewProps } from 'reactive-md/react/unstyled';
import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';

type Props = Omit<LocalDocumentViewProps, 'runtime' | 'urlPolicy'>;

/** Render a compiled document without repeating compilation on hydration. */
export default function CompiledDocumentView({ document, locale = 'zh', ...props }: Props) {
  const [current, setCurrent] = useState(() => createDocumentRuntime(document));
  let active = current;
  if (current.document !== document) {
    active = createDocumentRuntime(document);
    setCurrent(active);
  }

  useEffect(() => {
    active.mounted = true;
    return () => {
      active.mounted = false;
      // StrictMode immediately reattaches the same runtime in development.
      queueMicrotask(() => {
        if (!active.mounted) active.runtime.dispose();
      });
    };
  }, [active]);

  return (
    <LocalDocumentView
      {...props}
      document={document}
      runtime={active.runtime}
      locale={locale}
      urlPolicy={isAllowedReactiveUrl}
    />
  );
}

function createDocumentRuntime(document: LocalDocument): {
  document: LocalDocument;
  runtime: LocalRuntime;
  mounted: boolean;
} {
  return { document, runtime: createLocalRuntime(document), mounted: false };
}
