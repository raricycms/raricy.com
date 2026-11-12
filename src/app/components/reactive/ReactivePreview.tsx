'use client';

import { compileSource } from '@/lib/reactive/compile-source';
import { useEffect, useRef, useState } from 'react';
import {
  compileFailureDiagnostic, formatLocalDiagnostic, LocalCompileScheduler,
  type Diagnostic, type LocalCompileWorker,
} from 'reactive-md';
import { REACTIVE_COMPILE_OPTIONS } from '@/lib/reactive/host-components';
import { createClientReferenceReader, expandClientReferences } from '@/lib/reactive/client-compile';
import type { ReferenceDocument } from '@/lib/reactive/ref-adapter';
import type { ReferenceMode } from '@/lib/reactive/ref-types';
import ReactiveDocument from './ReactiveDocument';

export interface ReactivePreviewProps {
  source: string;
  referenceMode?: ReferenceMode;
  debounceMs?: number;
  refreshToken?: number;
}

export default function ReactivePreview({
  source, referenceMode = 'expand', debounceMs = 300, refreshToken = 0,
}: ReactivePreviewProps) {
  const [rendered, setRendered] = useState<ReferenceDocument | null>(null);
  const [errors, setErrors] = useState<Diagnostic[]>([]);
  const [pending, setPending] = useState(false);
  const [fallback, setFallback] = useState(false);
  const scheduler = useRef<LocalCompileScheduler | null>(null);
  const request = useRef<{ source: string } | null>(null);

  useEffect(() => {
    const reader = createClientReferenceReader();
    const current = new LocalCompileScheduler({
      fallbackCompile: compileSource,
      delay: debounceMs,
      createWorker: () => new Worker(new URL('../../../lib/reactive/compile.worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as LocalCompileWorker,
      onModeChange: (mode) => setFallback(mode === 'fallback'),
      onResult: ({ source: compiledSource, result }) => {
        const revision = request.current;
        if (!revision || revision.source !== compiledSource || scheduler.current !== current) return;
        if (!result.ok) {
          setErrors(result.diagnostics);
          setPending(false);
          return;
        }
        void expandClientReferences(result.document, reader, referenceMode).then((document) => {
          if (request.current !== revision) return;
          setErrors([]);
          setRendered(document);
          setPending(false);
        }).catch((error) => {
          if (request.current !== revision) return;
          setErrors([compileFailureDiagnostic(error)]);
          setPending(false);
        });
      },
    });
    setFallback(false);
    scheduler.current = current;
    return () => {
      request.current = null;
      scheduler.current = null;
      current.dispose();
    };
  }, [debounceMs, referenceMode, refreshToken]);

  useEffect(() => {
    request.current = { source };
    setPending(true);
    scheduler.current?.schedule(source, REACTIVE_COMPILE_OPTIONS);
  }, [source, debounceMs, referenceMode, refreshToken]);

  return (
    <div className="reactive-preview" data-reactive-preview-pending={pending ? 'true' : 'false'}>
      {errors.length > 0 && (
        <ul className="reactive-preview__errors" role="alert">
          {errors.map((diagnostic, index) => (
            <li key={index}>{formatLocalDiagnostic(diagnostic, 'zh')}</li>
          ))}
        </ul>
      )}
      {fallback && <p className="reactive-preview__status" role="status">本地检查：预览仍可用，编译可能较慢。</p>}
      {rendered ? (
        <ReactiveDocument document={rendered.document} hostData={rendered.hostData} preview role="preview" />
      ) : pending && <p className="reactive-preview__status" role="status">正在编译预览…</p>}
    </div>
  );
}
