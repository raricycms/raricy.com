import { adaptReactiveReferences, ADAPTER_VERSION } from './ref-adapter';
import { createServiceReferenceReader } from './ref-reader';
import { applyLegacyHtmlCompat } from './legacy-compat';
import type { ReferenceMode } from './ref-types';

/** Prepare compatibility edits and references for the current reader. */
export async function prepareReactiveDocument(
  source: string,
  context: {
    mode: ReferenceMode;
    viewer: Parameters<typeof createServiceReferenceReader>[1];
    clientIp?: string;
  },
) {
  // 历史 HTML 兼容改写**先于**引用适配，且保证等长（见 legacy-compat.ts 文件头）；
  // 引用 token 不会被这轮改写碰到。
  const compat = applyLegacyHtmlCompat(source);
  const result = await adaptReactiveReferences(compat.source, {
    mode: context.mode,
    dataImages: compat.dataImages,
    // compat 的返回类型里 mediaSources 是必填字段，直接读（R3-130）。
    mediaSources: compat.mediaSources,
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
