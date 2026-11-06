import { adaptReactiveReferences, ADAPTER_VERSION, compatMediaSources } from './ref-adapter';
import { createServiceReferenceReader } from './ref-reader';
import { applyLegacyHtmlCompat } from './legacy-compat';
import type { ReferenceMode } from './ref-types';
import type { ContentFormat } from '../content-format';

/** Server-only preparation. Page rendering stays on legacy until upstream integration. */
export async function prepareReactiveDocument(
  source: string,
  context: {
    mode: ReferenceMode;
    format: ContentFormat;
    viewer: Parameters<typeof createServiceReferenceReader>[1];
    clientIp?: string;
  },
) {
  // 历史 HTML 兼容改写**先于**引用适配，且保证等长（见 legacy-compat.ts 文件头）；
  // 引用 token 不会被这轮改写碰到。
  const compat = applyLegacyHtmlCompat(source);
  const result = await adaptReactiveReferences(compat.source, {
    mode: context.mode,
    parentFormat: context.format,
    dataImages: compat.dataImages,
    // 前向兼容桥：主后端在 media 接线后给 compat 返回值加 mediaSources。
    mediaSources: compatMediaSources(compat),
    resolve: context.mode === 'expand'
      ? createServiceReferenceReader('expand', context.viewer, context.clientIp)
      : undefined,
  });
  return {
    ...result,
    compat,
    adapterVersion: ADAPTER_VERSION,
  };
}
