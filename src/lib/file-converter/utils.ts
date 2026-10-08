// ─────────────────────────────────────────────────────────────────────────────
// file-converter/utils.ts —— 文件名、下载与错误归类的公共工具（零依赖纯函数 +
// 少量 DOM 辅助，DOM 辅助集中在文件末尾，node 单测只碰纯函数区）。
//
// 【纪律】plan §5.3：
//   · 输出名形如 `录音-converted.mp3`，重复加序号；
//   · 文件名是普通文本，不能当 HTML，也不能直接作为引擎内部路径（引擎用内部名）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ConvertError, ErrorKind } from './types';

/** 去掉路径与控制字符，保留 Unicode；空名给占位。 */
export function sanitizeBase(name: string): string {
  // 只取最后一段（防 a/b/c.png），去控制字符与引号
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[\u0000-\u001F\u007F"]/g, '').trim();
  const noExt = cleaned.includes('.') ? cleaned.slice(0, cleaned.lastIndexOf('.')) : cleaned;
  // 前导点剥掉：「...」/「.gitignore」这类名字直接拼输出名会得到 `...jpg`
  // （Unix 下是隐藏文件，用户下载完「找不到文件」）。
  const trimmed = noExt.replace(/^\.+/, '').slice(0, 80).trim();
  return trimmed || 'file';
}

/** 组装输出名；taken 里已有的自动加 `-2` `-3`。 */
export function uniqueOutputName(base: string, ext: string, taken: Set<string>): string {
  const clean = sanitizeBase(base);
  let candidate = `${clean}.${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${clean}-${n}.${ext}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

/** 转换输出的标准命名：`<原名去扩展>-converted.<ext>`。 */
export function convertedName(originalName: string, ext: string, taken: Set<string>): string {
  return uniqueOutputName(`${sanitizeBase(originalName)}-converted`, ext, taken);
}

/** 归类底层异常 → 用户可理解的错误。引擎错误文案杂乱，归不到类的给通用文案。 */
export function classifyError(e: unknown, fallback: string): ConvertError {
  const anyErr = e as Partial<ConvertError> & { name?: string };
  if (anyErr?.kind && anyErr?.message) {
    return { kind: anyErr.kind, message: anyErr.message, detail: anyErr.detail };
  }
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  let kind: ErrorKind = 'unknown';
  if (anyErr?.name === 'AbortError' || lower.includes('abort')) kind = 'cancelled';
  else if (lower.includes('timeout') || lower.includes('超时')) kind = 'timeout';
  else if (lower.includes('memory') || lower.includes('out of memory')) kind = 'budget';
  else if (lower.includes('decode') || lower.includes('invalid') || lower.includes('corrupt') || lower.includes('moov')) {
    kind = 'corrupt';
  }
  return { kind, message: fallback, detail: msg.slice(0, 500) };
}

/** 带超时的 Promise 包装（引擎调用用）。超时后以带 kind 的错误 reject。 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject({ kind: 'timeout', message } satisfies ConvertError);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 数字钳制。 */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 安全解析正整数；非法返回 null。 */
export function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 页码范围解析（「1-3,5,8-」→ [1,2,3,5,8…max]）。越界与重复去重，空串 = 全部。
 * 返回 null = 语法错误（调用方提示，不静默忽略）。
 */
export function parsePageRange(input: string, max: number): number[] | null {
  const t = input.trim();
  if (!t) {
    return Array.from({ length: max }, (_, i) => i + 1);
  }
  const out = new Set<number>();
  for (const part of t.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = /^(\d+)\s*-\s*(\d*)$/.exec(seg);
    if (m) {
      const a = parseInt(m[1], 10);
      const bEnd = m[2] === '' ? max : parseInt(m[2], 10);
      if (a < 1 || bEnd > max || a > bEnd) return null;
      for (let i = a; i <= bEnd; i++) out.add(i);
      continue;
    }
    if (/^\d+$/.test(seg)) {
      const n = parseInt(seg, 10);
      if (n < 1 || n > max) return null;
      out.add(n);
      continue;
    }
    return null;
  }
  return [...out].sort((a, b) => a - b);
}

// ─── DOM 辅助（仅客户端调用；node 单测别碰下面这段）───────────────────────────

/** 触发一次浏览器下载。 */
export function downloadBlob(blob: Blob, name: string): string {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}
