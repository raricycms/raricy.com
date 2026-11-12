'use client';

import { useCallback } from 'react';
import type { LocalDocumentViewProps, LocalHostRenderer } from 'reactive-md/react/unstyled';
import CompiledDocumentView from './CompiledDocumentView';
import { SiteEmbedView } from './SiteEmbedView';

interface ReactiveDocumentProps extends Pick<
  LocalDocumentViewProps, 'document' | 'hostData' | 'mode' | 'staticFirst' | 'locale'
> {
  preview?: boolean;
  role?: 'read' | 'preview';
}

export default function ReactiveDocument({
  preview = false,
  role = 'read',
  ...props
}: ReactiveDocumentProps) {
  const hostRenderer = useCallback<LocalHostRenderer>(
    (node, data, context) => SiteEmbedView(node, data, context, { preview }),
    [preview]
  );

  return (
    <div className="reactive-document" data-content-renderer={role}>
      <CompiledDocumentView {...props} hostRenderer={hostRenderer} />
    </div>
  );
}
