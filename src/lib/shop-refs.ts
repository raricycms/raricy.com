// 商城共享租期词汇。一个月固定 30 天，展示、校验与续期必须读同一份表。
export type RentUnit = 'day' | 'month';
export interface RentUnitSpec {
  days: number;
  min: number;
  max: number;
  noun: string;
  priceNoun: string;
}
export const RENT_UNITS: Record<RentUnit, RentUnitSpec> = {
  day: { days: 1, min: 1, max: 30, noun: '天', priceNoun: '鱼干 / 天' },
  month: { days: 30, min: 1, max: 12, noun: '个月', priceNoun: '鱼干 / 月' },
};
export function isRentCountInRange(unit: RentUnit, count: number): boolean {
  const { min, max } = RENT_UNITS[unit];
  return Number.isInteger(count) && count >= min && count <= max;
}
export function parseRentCount(unit: RentUnit, raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return isRentCountInRange(unit, n) ? n : null;
}
