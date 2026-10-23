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
 */
export function useCraftDraft<T>(key: string, fresh: () => T, parse: (raw: string | null) => T | null) {
  const [draft, setDraft] = useState<T>(fresh);
  const [ready, setReady] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    const { raw, failed } = readCraftDraft(key);
    const next = parseRef.current(raw);
    if (next) setDraft(next);
    else if (raw !== null) setSaveFailed(true);
    if (failed) setSaveFailed(true);
    setReady(true);
  }, [key]);

  useEffect(() => {
    if (!ready) return;
    // 拖梭子 / 拉针时状态每秒会变几十次，攒一小段再落盘；最后一次改动也会写入。
    const timer = window.setTimeout(() => {
      if (!writeCraftDraft(key, JSON.stringify(draft))) setSaveFailed(true);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draft, key, ready]);

  return { draft, setDraft, ready, saveFailed };
}
