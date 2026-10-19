export const WORLD_WIDTH = 960;
export const WORLD_HEIGHT = 640;
export const TILE = 40;
export const TICK_MS = 50;
export const MAX_PLAYERS = 32;
export const MAX_SLIMES = 28;
export const SPEED = 150;
export const ATTACK_MS = 360;
export const ATTACK_COOLDOWN = 480;
export const INPUT = { up: 1, down: 2, left: 4, right: 8, attack: 16 } as const;
export const DIRECTIONS = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }] as const;
export type Facing = 0 | 1 | 2 | 3;
export type SlimeMood = 'wander' | 'chase' | 'windup' | 'lunge' | 'stunned' | 'dying';
export interface Player { id: string; name: string; x: number; y: number; facing: Facing; moving: boolean; attack: number; hurt: number; catnip: number }
export interface Slime { id: number; x: number; y: number; kind: number; hp: number; mood: SlimeMood; phase: number }
export interface Ranking { id: string; name: string; catnip: number; connections: number }
export interface Snapshot { type: 'wand2.snapshot'; tick: number; players: Player[]; slimes: Slime[]; leaderboard: Ranking[] }

// 0 草地 / 1 碎石 / 2 小径。碰撞与画面共用同一张地图。
export const TILES = Array.from({ length: WORLD_HEIGHT / TILE }, (_, y) => Array.from({ length: WORLD_WIDTH / TILE }, (_, x) => {
  if ((x === 5 && y >= 3 && y <= 5) || (y === 11 && x >= 6 && x <= 8)
    || (x >= 17 && x <= 18 && y >= 3 && y <= 4) || (x === 19 && y >= 11 && y <= 13)) return 1;
  if ((y === 7 || y === 8) || (x === 11 || x === 12)) return 2;
  return 0;
}));

// 只传按键和单调序号，坐标、命中和奖励均由服务端决定。
export function encodeInput(buttons: number, sequence: number): Uint8Array {
  return new Uint8Array([2, buttons & 31, (sequence >> 8) & 255, sequence & 255]);
}
export function decodeInput(data: Uint8Array): { buttons: number; sequence: number } | null {
  return data.length === 4 && data[0] === 2 && data[1] <= 31 ? { buttons: data[1], sequence: (data[2] << 8) | data[3] } : null;
}
const integer = (n: unknown, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
const text = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max;
const position = (p: Record<string, unknown>) => typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= 0 && p.x <= WORLD_WIDTH
  && typeof p.y === 'number' && Number.isFinite(p.y) && p.y >= 0 && p.y <= WORLD_HEIGHT;
export function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.type !== 'wand2.snapshot' || !integer(s.tick, Number.MAX_SAFE_INTEGER) || !Array.isArray(s.players) || s.players.length > MAX_PLAYERS
    || !Array.isArray(s.slimes) || s.slimes.length > MAX_SLIMES || !Array.isArray(s.leaderboard) || s.leaderboard.length > MAX_PLAYERS) return null;
  for (const p of s.players) {
    if (!p || typeof p !== 'object' || !text(p.id, 128) || !text(p.name, 32) || !position(p) || !integer(p.facing, 3)
      || typeof p.moving !== 'boolean' || !integer(p.attack, ATTACK_MS) || !integer(p.hurt, 850) || !integer(p.catnip, Number.MAX_SAFE_INTEGER)) return null;
  }
  for (const m of s.slimes) {
    if (!m || typeof m !== 'object' || !integer(m.id, Number.MAX_SAFE_INTEGER) || !position(m) || !integer(m.kind, 2) || !integer(m.hp, 3)
      || !['wander', 'chase', 'windup', 'lunge', 'stunned', 'dying'].includes(m.mood) || !integer(m.phase, 2000)) return null;
  }
  for (const r of s.leaderboard) {
    if (!r || typeof r !== 'object' || !text(r.id, 128) || !text(r.name, 32) || !integer(r.catnip, Number.MAX_SAFE_INTEGER) || !integer(r.connections, MAX_PLAYERS)) return null;
  }
  if (new Set(s.players.map(p => p.id)).size !== s.players.length || new Set(s.slimes.map(m => m.id)).size !== s.slimes.length) return null;
  return s as unknown as Snapshot;
}
