// ─────────────────────────────────────────────────────────────────────────────
// file-converter/registry.ts —— 能力登记表的查询与运行时过滤（零依赖）
//
// 【它是什么】roadmap §12.1 的「有方向的图」的读口：识别输入后，只展示满足条件
// 的目标。不存在的边不靠改后缀补上。
//
// 【纪律】零运行时依赖（type import 除外）—— node 单测直接驱动过滤逻辑。
// 边的**定义**住在各 category 模块（它们 import 引擎），这里只做集合运算。
// ─────────────────────────────────────────────────────────────────────────────

import type { CapabilityReport, CategoryDef, EdgeDef, InspectInfo } from './types';

/** 登记册完整性校验（单测调用；问题清单为空 = 通过）。 */
export function registryProblems(categories: CategoryDef[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const cat of categories) {
    if (!cat.edges) {
      problems.push(`${cat.key}: edges 缺失`);
      continue;
    }
    for (const e of cat.edges) {
      if (ids.has(e.id)) problems.push(`重复的边 id：${e.id}`);
      ids.add(e.id);
      if (!e.id.startsWith(`${cat.key === 'document' ? '' : cat.key}:`) && cat.key !== 'document') {
        problems.push(`${e.id}: id 前缀应为类别键（${cat.key}:）`);
      }
      if (!e.label) problems.push(`${e.id}: 缺 label`);
      if (!e.to) problems.push(`${e.id}: 缺输出格式 to`);
      if (e.from.length === 0) problems.push(`${e.id}: from 为空`);
      if (e.status === 'planned') {
        if (e.run) problems.push(`${e.id}: planned 状态不应实现 run（仅登记）`);
      } else if (typeof e.run !== 'function') {
        problems.push(`${e.id}: 缺 run 实现`);
      }
      const paramKeys = new Set<string>();
      for (const p of e.params) {
        if (paramKeys.has(p.key)) problems.push(`${e.id}: 重复参数 ${p.key}`);
        paramKeys.add(p.key);
        if (p.type === 'select' && !p.options) problems.push(`${e.id}: select 参数 ${p.key} 缺 options`);
        if (p.type === 'range' && (p.min === undefined || p.max === undefined)) {
          problems.push(`${e.id}: range 参数 ${p.key} 缺 min/max`);
        }
      }
    }
  }
  return problems;
}

/** 单个能力要求是否满足。 */
function requirementMet(req: string, caps: CapabilityReport): boolean {
  switch (req) {
    case 'webp-encode':
      return caps.webpEncode;
    case 'avif-encode':
      return caps.avifEncode;
    case 'avif-decode':
      return caps.avifDecode;
    case 'worker':
      return caps.workerOk;
    case 'ffmpeg':
      return caps.ffmpeg?.loaded ?? false;
    default:
      if (req.startsWith('ffmpeg-enc:')) {
        return (caps.ffmpeg?.encoders ?? []).includes(req.slice('ffmpeg-enc:'.length));
      }
      if (req.startsWith('ffmpeg-dec:')) {
        return (caps.ffmpeg?.decoders ?? []).includes(req.slice('ffmpeg-dec:'.length));
      }
      return false;
  }
}

/**
 * 一条边当前是否可执行。**能力未探测前，FFmpeg 依赖按「可满足」处理**
 * （否则菜单要等 31MB 核心下载完才出现 —— 那是「先下载再决定能干什么」的本末倒置；
 * 核心加载失败时页面会把对应目标标为不可用并说明）。
 */
export function edgeAvailable(edge: EdgeDef, caps: CapabilityReport): boolean {
  if (edge.status === 'planned') return false;
  for (const req of edge.requires ?? []) {
    if (req === 'ffmpeg' || req.startsWith('ffmpeg-enc:') || req.startsWith('ffmpeg-dec:')) {
      if (caps.ffmpeg === null) continue; // 未加载：先展示，首次任务触发加载
      if (caps.ffmpeg.error) return false;
      if (!requirementMet(req, caps)) return false;
      continue;
    }
    if (!requirementMet(req, caps)) return false;
  }
  return true;
}

/** 对一次识别结果，列出该类别的可执行目标（roadmap：只展示满足条件的目标）。 */
export function availableEdges(
  category: CategoryDef,
  info: InspectInfo,
  caps: CapabilityReport
): EdgeDef[] {
  return category.edges.filter(
    (e) => e.from.includes(info.sniff.kind) && (e.match ? e.match(info) : true) && edgeAvailable(e, caps)
  );
}

/** 按 id 找边。 */
export function edgeById(categories: CategoryDef[], id: string): EdgeDef | null {
  for (const c of categories) {
    const e = c.edges.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}
