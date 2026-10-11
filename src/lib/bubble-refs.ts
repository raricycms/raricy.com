// 气泡定义只住代码，客户端与服务端共用；不接收用户提供的 CSS、HTML 或外链素材。
// 停售（移除 rent）与停用（disabled）分开。保留 key，历史持有记录仍可解释和卸下。
import { isRentCountInRange, type RentUnit } from './shop-refs';

export const BUBBLE_KEYS = ['blue-square'] as const;
export type BubbleKey = (typeof BUBBLE_KEYS)[number];
export interface BubbleDef {
  label: string;
  description: string;
  disabled?: boolean;
  rent?: { unit: RentUnit; price: number };
}
export const BUBBLES: Record<BubbleKey, BubbleDef> = {
  'blue-square': {
    label: '蓝色直角',
    description: '清爽的蓝色底与利落直角，适用于讨论大区和私聊。',
    rent: { unit: 'month', price: 10 },
  },
};
export function parseBubbleKey(raw: unknown): BubbleKey | null {
  return typeof raw === 'string' && (BUBBLE_KEYS as readonly string[]).includes(raw)
    ? raw as BubbleKey : null;
}
export function bubbleSaleOf(key: BubbleKey) {
  const def = BUBBLES[key];
  return !def.disabled && def.rent && Number.isFinite(def.rent.price) && def.rent.price > 0
    ? def.rent : null;
}
export function rentableBubbleKeys(): BubbleKey[] {
  return BUBBLE_KEYS.filter((key) => bubbleSaleOf(key) !== null);
}
export function bubbleRentCost(key: BubbleKey, count: number): number | null {
  const sale = bubbleSaleOf(key);
  return sale && isRentCountInRange(sale.unit, count) ? sale.price * count : null;
}
// NULL 是永久；与头像框一致，相同时间仍有效。比较只在服务端调用，使用库内时钟。
export function isBubbleExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now > expiresAt;
}
export function resolveBubbleKey(raw: unknown, expiresAt: Date | null, now: Date): BubbleKey | null {
  const key = parseBubbleKey(raw);
  return key && !BUBBLES[key].disabled && !isBubbleExpired(expiresAt, now) ? key : null;
}
