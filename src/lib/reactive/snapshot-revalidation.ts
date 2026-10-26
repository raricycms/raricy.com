// ─────────────────────────────────────────────────────────────────────────────
// snapshot-revalidation.ts — 持久快照的**引用新鲜度**判据（纯函数）
//
// 快照里的 `document` + `hostData` 是**发布那一刻**的 external 公开语境。阅读时
// 直接拿来用，下面这些变化会被静默忽略（页面照常渲染，只是内容已经是旧的）：
//
//   · 公开剪贴板改成私密 / 软删 → 旧卡片还挂在那里，标题也还在；
//   · 标题 / 格式 / 版本变化 → 读者看到旧标题；
//   · 私有剪贴板后来公开 → 新引用**永远不出现**（快照里根本没有它）。
//
// 所以使用快照前必须按当前 external 权限重验一次，比较对象就是 `hostData`。
//
// 【为什么只需要比 hostData】external 视图里只有剪贴板带可变数据：
//   · 音频的 hostData 由 id 直接决定（权限在 `/api/audio/<id>/raw` 逐条判）；
//   · 图床只拼 URL，不取数；
//   · 投票 / 收藏夹在 external 视图里保留字面量，不进 hostData。
// 于是「hostData 完全一致」= 快照里的引用数据就是当前公开权限下的那一份。
//
// 【无剪贴板引用 → 快照快速路径】`hasMutableExternalReferences` 为 false 时调用方
// 一次数据库查询都不发。宁可对 `[@…]` 形态的剪贴板 token 多查一次，也不要因为
// 白名单漂移而静默跳过重验。
//
// 零 prisma / 零 HTTP（扫描器是 ref-adapter + favorite-refs 里的纯逻辑）。
// ─────────────────────────────────────────────────────────────────────────────

import { scanReactiveReferences } from './ref-adapter';
import type { SiteEmbedData, SiteHostData } from './ref-types';

/**
 * 正文里有没有**会随公开权限变化**的引用（目前只有剪贴板）。
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
