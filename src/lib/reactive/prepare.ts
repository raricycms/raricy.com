import { resolvePublicClipRefs } from '../clipboard-service';
import { adaptReactiveReferences, ADAPTER_VERSION } from './ref-adapter';
import { createServiceReferenceReader } from './ref-reader';
import { reactiveContentHash } from './cache';
import type { ReferenceMode } from './ref-types';

/** Server-only preparation. Page rendering stays on legacy until upstream integration. */
export async function prepareReactiveDocument(
  source: string,
  context: {
    mode: ReferenceMode;
    viewer: Parameters<typeof createServiceReferenceReader>[1];
    clientIp?: string;
  },
) {
  const externalClips = context.mode === 'external' ? await resolvePublicClipRefs(source) : undefined;
  const result = await adaptReactiveReferences(source, {
    mode: context.mode,
    externalClips,
    resolve: context.mode === 'expand'
      ? createServiceReferenceReader('expand', context.viewer, context.clientIp)
      : undefined,
  });
  return {
    ...result,
    sourceHash: reactiveContentHash(source),
    adaptedHash: reactiveContentHash(result.adaptedSource),
    adapterVersion: ADAPTER_VERSION,
  };
}
