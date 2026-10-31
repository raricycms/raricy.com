import { adaptReactiveReferences, ADAPTER_VERSION } from './ref-adapter';
import { createServiceReferenceReader } from './ref-reader';
import { reactiveContentHash } from './cache';
import { applyLegacyHtmlCompat } from './legacy-compat';
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
  // 历史 HTML 兼容改写**先于**引用适配，且保证等长 —— 否则 source-map 的偏移
  // 会对不上原文（见 legacy-compat.ts 文件头）。引用 token 不会被这轮改写碰到。
  const compat = applyLegacyHtmlCompat(source);
  const result = await adaptReactiveReferences(compat.source, {
    mode: context.mode,
    resolve: context.mode === 'expand'
      ? createServiceReferenceReader('expand', context.viewer, context.clientIp)
      : undefined,
  });
  return {
    ...result,
    compat,
    sourceHash: reactiveContentHash(source),
    adaptedHash: reactiveContentHash(result.adaptedSource),
    adapterVersion: ADAPTER_VERSION,
  };
}
