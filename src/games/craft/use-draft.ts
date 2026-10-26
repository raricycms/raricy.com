'use client';

import { useEffect, useRef, useState } from 'react';
import { readCraftDraft, writeCraftDraft } from './storage';

/**
 * 三款手工游戏共用的草稿钩子。
 *
 * 首帧必须与 localStorage 无关（否则服务端 HTML 与客户端首帧不一致），所以初值
 * 一律是 fresh()，挂载后再读盘；ready 之前不保存，避免用空草稿覆盖真存档。
 * 读取失败（坏 JSON / 存储被禁）时保留空草稿并把 saveFailed 立起来 —— 页面照常可玩，
 * 只是明确告诉玩家这一局不会被记住。
 *
 * 【最后一笔必须在离开页面时写掉】落盘有 220ms 防抖，只靠依赖数组里那个 effect
 * 是不够的：刷新 / 关标签会让组件直接卸载，cleanup 一 `clearTimeout`，压在防抖里
 * 的那一笔就**永远丢了** —— 而且只丢最后那一笔，症状是"刚才那步没生效"，
 * 看着像状态没提交。所以另挂一条 flush：卸载、`pagehide`、以及页面转后台时
 * 立刻落盘。`pagehide` 是 `beforeunload` 的可靠替代（移动端与 bfcache 都能收到）。
 */
export function useCraftDraft<T>(key: string, fresh: () => T, parse: (raw: string | null) => T | null) {
  const [draft, setDraft] = useState<T>(fresh);
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  /** 最新一版草稿 —— flush 发生在 effect 之外，读不到闭包里的那份。 */
  const latestRef = useRef(draft);
  latestRef.current = draft;
  const readyRef = useRef(false);

  useEffect(() => {
    const { raw, failed } = readCraftDraft(key);
    const next = parseRef.current(raw);
    if (next) setDraft(next);
    else if (raw !== null) setSaveFailed(true);
    if (failed) setSaveFailed(true);
    readyRef.current = true;
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready) return;
    // 拖梭子 / 拉针时状态每秒会变几十次，攒一小段再落盘。
    const timer = window.setTimeout(() => {
      if (!writeCraftDraft(key, JSON.stringify(draft))) setSaveFailed(true);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draft, key, ready]);

  useEffect(() => {
    if (!ready) return;
    /** 立刻落盘。仍然挂着的时候才报失败 —— 卸载途中谁都看不见那句提示。 */
    const flush = (report: boolean) => {
      if (!readyRef.current) return;
      const ok = writeCraftDraft(key, JSON.stringify(latestRef.current));
      if (!ok && report) setSaveFailed(true);
    };
    const onPageHide = () => flush(false);
    const onVisibility = () => {
      // 转到后台可能再也不会回来（移动端），当离开处理。
      if (document.visibilityState === 'hidden') flush(false);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // 路由切走 / 刷新前的最后一道：cleanup 里同步写完，别留在防抖里。
      flush(false);
    };
  }, [key, ready]);

  return { draft, setDraft, ready, saveFailed };
}
