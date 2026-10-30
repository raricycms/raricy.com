// ─────────────────────────────────────────────────────────────────────────────
// snapshot-revalidation.ts — 持久快照的**引用新鲜度**判据（纯函数）
//
// external 视图不展开站内剪贴板、投票和收藏夹，也不读取它们的资源数据。
// 仍对含剪贴板 token 的快照执行 hostData 对账：即使持久数据意外携带旧引用载荷，
// 也必须拒绝它并按当前 external 规则重新编译。适配器签名另负责拒绝旧版本快照。
// 图床与音频的宿主数据由 ID 确定，读取权限继续由各自资源接口判断。
// 对账使用当前适配结果，不向数据库取片段，不恢复旧的访客展开行为。
//
// 零 prisma / 零 HTTP（扫描器是 ref-adapter + favorite-refs 里的纯逻辑）。
// ─────────────────────────────────────────────────────────────────────────────

import { scanReactiveReferences } from './ref-adapter';
import type { SiteEmbedData, SiteHostData } from './ref-types';

/**
 * 正文里有没有需要检查旧载荷的剪贴板引用。
 *
 * 扫描跑在盖码副本上（`scanReactiveReferences` 自带），代码块里的 token 不算。
 */
export function hasMutableExternalReferences(source: string): boolean {
  return scanReactiveReferences(source).some((slot) => slot.kind === 'clipboard');
}

/**
 * 一个宿主数据的语义签名。按字段固定顺序序列化，不依赖对象键顺序 ——
 * 快照来自 JSON 往返、当前数据来自适配器，两边键顺序不保证一致。
 */
function embedSignature(data: SiteEmbedData | undefined): string {
  if (!data) return 'null';
  return JSON.stringify([
    data.kind,
    data.ref,
    data.status,
    data.title ?? null,
    data.format ?? null,
    data.version ?? null,
    data.content ?? null,
    data.payload ?? null,
  ]);
}

/** 两份 hostData 是否表达同一份引用数据（键集合 + 每个键的字段值）。 */
export function hostDataEqual(a: SiteHostData, b: SiteHostData): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    if (embedSignature(a[key]) !== embedSignature(b[key])) return false;
  }
  return true;
}
