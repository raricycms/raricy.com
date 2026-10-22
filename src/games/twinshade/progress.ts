// ─────────────────────────────────────────────────────────────────────────────
// progress.ts — 双影的存档：纯逻辑 + localStorage 容错
//
// 【为什么这一层要自己兜住 localStorage 的所有脾气】
// 玩具区对匿名访客开放，进度只存在浏览器里（不进库、不发请求），于是这个模块会在
// 四种「localStorage 不是你想的那样」的环境里被调用：
//   · SSR / 静态预渲染 —— 模块在 node 里求值，`window` 根本不存在；
//   · 单元测试（node）—— 同上，但会直接调这里的函数；
//   · 浏览器隐私模式 —— Safari 老版本里 `localStorage` 存在、读也不抛，**写会抛**；
//   · 配额满 / 用户禁用了站点数据 —— setItem 抛 QuotaExceededError。
// 这四种里只要有一种让异常逃出去，游戏开局就会白屏或整段无法操作，而「存档失败」
// 本身不该是玩家需要知道的事。所以这里的口径是：**任何存储路径都不许抛**，
// 拿不到存储就静默退化成模块级内存态（本次浏览有效，刷新即丢）。
//
// 【为什么所有函数都是纯的（不自己落盘）】
// 容器（TwinShade.tsx）一次操作会算出新状态再统一 saveProgress 一次，写盘次数与
// 操作次数一一对应；如果 recordClear 内部自己写，一次操作会被写两遍，且「拒绝更差
// 成绩」那种分支会在写盘后才发现，徒增一次无效写入。
// ─────────────────────────────────────────────────────────────────────────────

import type { ProgressState } from './ui-types';

/**
 * localStorage 的键。带版本号：**改形状或整批换关卡时换版本**，旧键自然失效、不做迁移。
 * 2026-10 关卡表整体重做（旧关卡全部替换成更难的 14 关）→ v1 升到 v2；
 * 同月又重做了 b2 / c1 / c2 / c4 四关（石头必须被推，路线与 par 全变了）→ 升到 v3。
 * 旧成绩对应的是另一批关卡，留着只会让玩家看到「最好 2 步」却要 10 步才过。
 */
export const PROGRESS_KEY = 'twinshade_progress_v3';

type BestMap = Record<string, number>;

/** 全新玩家的状态。每次返回新对象：默认值若被共享，一处 `best` 污染会波及所有调用点。 */
function defaults(): ProgressState {
  return { version: 1, best: {}, seenIntro: false, muted: false, lastLevelId: null };
}

/**
 * 模块级内存态：存取都不可用时的唯一真相。
 * 初值是默认值 —— 于是「从没成功读过存储」也等价于「新玩家」，不需要额外分支。
 */
let memory: ProgressState = defaults();

/**
 * 存储可用性缓存。`false` 一旦定下就整段会话不再重试：隐私模式与配额满都不会在
 * 同一次页面生命周期里自己好起来，而每次发声都去撞一次异常纯属浪费。
 */
let storageUsable: boolean | null = null;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  if (storageUsable === false) return null;
  try {
    // 只探「能不能拿到对象、读会不会抛」。写失败的那一档交给 saveProgress 自己兜。
    const ls = window.localStorage;
    ls.getItem(PROGRESS_KEY);
    storageUsable = true;
    return ls;
  } catch {
    storageUsable = false;
    return null;
  }
}

/**
 * 把「任意外部数据」收成合法的 best 表。
 * 逐条筛而不是整表丢：一条坏记录不该抹掉其它关的成绩。步数必须是**正整数** ——
 * 0 步通关在规则上不存在，出现就说明数据被手改过，宁可当成没成绩。
 */
function sanitizeBest(raw: unknown): BestMap {
  const out: BestMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) continue;
    out[id] = Math.floor(value);
  }
  return out;
}

/**
 * 解析存档串。坏 JSON / 不是对象 / 版本不符 → 全新默认值（按约定不迁移旧版本）；
 * 缺字段 → 只把那一个字段退回默认值，其余照留。
 */
function parse(raw: string | null): ProgressState {
  const fallback = defaults();
  if (!raw) return fallback;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
  const row = data as Record<string, unknown>;
  // 版本不符 → 整体重置。宁可让玩家重打，也不要把另一套语义的字段读进来。
  if (row.version !== 1) return fallback;
  return {
    version: 1,
    best: sanitizeBest(row.best),
    seenIntro: row.seenIntro === true,
    muted: row.muted === true,
    lastLevelId: typeof row.lastLevelId === 'string' && row.lastLevelId ? row.lastLevelId : null,
  };
}

/** 读存档。读不到 / 坏数据 / 版本不符都在这里收口，调用方不需要 try/catch。 */
export function loadProgress(): ProgressState {
  const ls = storage();
  if (!ls) return memory;
  let raw: string | null;
  try {
    raw = ls.getItem(PROGRESS_KEY);
  } catch {
    storageUsable = false;
    return memory;
  }
  // 键不存在（第一次来）→ 内存态。若之前写过但写失败，内存里那份才是玩家看到的进度。
  if (raw === null) return memory;
  memory = parse(raw);
  return memory;
}

/** 写存档。永不抛；写不进去就只留在内存里（本次浏览仍然记得）。 */
export function saveProgress(p: ProgressState): void {
  memory = p;
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    // 配额满 / 隐私模式：本次会话不再尝试写盘，但内存态继续生效。
    storageUsable = false;
  }
}

/**
 * 按步数算星。分档沿用「最优 / 宽限 / 完成」三档，宽限取 `max(2, ceil(par/2))`：
 * par 很小的关卡（3–4 步）用固定 2 步宽限，否则「多走一步」就直接掉到 1 星，
 * 显得刻薄；par 大的关卡按比例宽限，才不会宽到随便乱走也两星。
 */
export function starsFor(moves: number, par: number): 1 | 2 | 3 {
  const m = Number.isFinite(moves) ? Math.max(0, Math.floor(moves)) : Number.MAX_SAFE_INTEGER;
  const p = Number.isFinite(par) ? Math.max(1, Math.ceil(par)) : 1;
  if (m <= p) return 3;
  if (m <= p + Math.max(2, Math.ceil(p * 0.5))) return 2;
  return 1;
}

/**
 * 记一次通关。只留更好的成绩（相同步数也不覆盖，避免无谓的对象分配与写盘）。
 * `lastLevelId` 不论成绩好坏都更新 —— 「下次进来续上」指的是**刚打过的这一关**，
 * 而不是「历史最好成绩那一关」；重打旧关卡的玩家显然还想接着打它。
 */
export function recordClear(p: ProgressState, levelId: string, moves: number): ProgressState {
  if (!levelId) return p;
  if (!Number.isFinite(moves) || moves < 1) return p;
  const step = Math.floor(moves);
  const prev = p.best[levelId];
  const better = prev === undefined || step < prev;
  if (!better && p.lastLevelId === levelId) return p;
  return {
    ...p,
    best: better ? { ...p.best, [levelId]: step } : p.best,
    lastLevelId: levelId,
  };
}

/** 记住「正在玩哪一关」（进入 / 切关时调）。相同 id 返回原对象，省掉一次重渲染。 */
export function rememberLevel(p: ProgressState, levelId: string): ProgressState {
  if (!levelId || p.lastLevelId === levelId) return p;
  return { ...p, lastLevelId: levelId };
}

/** 静音开关。相同值返回原对象，理由同上。 */
export function setMuted(p: ProgressState, muted: boolean): ProgressState {
  if (p.muted === muted) return p;
  return { ...p, muted };
}
