export const WAND_WIDTH = 500;
export const WAND_HEIGHT = 500;
export const WAND_RADIUS = 10;
export const WAND_SPEED = 95;
export const WAND_TICK_MS = 50;
export const WAND_MAX_PLAYERS = 32;
export const WAND_INPUT = { up: 1, down: 2, left: 4, right: 8 } as const;

export const WAND_TILES: readonly (readonly number[])[] = [
  [0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0],
  [0,0,0,1,1,1,1,0,0,0],
  [0,0,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,0,0],
  [0,0,0,1,1,1,1,0,0,0],
  [0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0],
];

export interface WandPlayer { id: string; name: string; x: number; y: number }
export interface WandSnapshot { type: 'wand.snapshot'; players: WandPlayer[] }

// 4 字节输入帧：opcode / 方向位 / uint16 序号（网络字节序）。不接受客户端坐标。
export function encodeWandInput(buttons: number, sequence: number): Uint8Array {
  return new Uint8Array([1, buttons & 15, (sequence >> 8) & 255, sequence & 255]);
}

export function decodeWandInput(data: Uint8Array): { buttons: number; sequence: number } | null {
  if (data.byteLength !== 4 || data[0] !== 1 || data[1] > 15) return null;
  return { buttons: data[1], sequence: (data[2] << 8) | data[3] };
}

export function parseWandSnapshot(value: unknown): WandSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const packet = value as Record<string, unknown>;
  if (packet.type !== 'wand.snapshot' || !Array.isArray(packet.players) || packet.players.length > WAND_MAX_PLAYERS) return null;
  const players: WandPlayer[] = [];
  for (const raw of packet.players) {
    if (!raw || typeof raw !== 'object') return null;
    const player = raw as Record<string, unknown>;
    if (typeof player.id !== 'string' || player.id.length > 128 || typeof player.name !== 'string' || player.name.length > 32
        || typeof player.x !== 'number' || !Number.isFinite(player.x) || player.x < 0 || player.x > WAND_WIDTH
        || typeof player.y !== 'number' || !Number.isFinite(player.y) || player.y < 0 || player.y > WAND_HEIGHT) return null;
    players.push({ id: player.id, name: player.name, x: player.x, y: player.y });
  }
  return { type: 'wand.snapshot', players };
}
