// 游戏操作只传意图；身份、颜色、坐标、生命与分数由服务端决定。
export const QUANDI_MODES = ['explore', 'fight', 'infinite', 'survival', 'capture', 'daynight'] as const;
export const QUANDI_DIFFICULTIES = ['slow', 'medium', 'fast', 'ultra'] as const;
export type QuandiMode = typeof QUANDI_MODES[number];
export type QuandiDifficulty = typeof QUANDI_DIFFICULTIES[number];
export const QUANDI_MAX_ROOMS = 16;
export const QUANDI_MAX_PLAYERS = 64;
export const QUANDI_ROOM_IDLE_MS = 5 * 60_000;
export const QUANDI_ROUND_MAX_MS = 10 * 60_000;
export const QUANDI_INPUT_TIMEOUT_MS = 300;

export type QuandiCommand =
  | { type: 'C2S_CREATE_ROOM'; data: { mode: QuandiMode; difficulty: QuandiDifficulty } }
  | { type: 'C2S_JOIN_ROOM'; data: { roomCode: string } }
  | { type: 'C2S_SET_READY'; data: { isReady: boolean } }
  | { type: 'C2S_PLAYER_INPUT'; data: { direction: { x: number; y: number }; seq: number } }
  | { type: 'C2S_START_GAME' | 'C2S_LEAVE_ROOM' | 'C2S_FORFEIT' | 'C2S_PING'; data: Record<string, never> };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function parseQuandiCommand(value: unknown): QuandiCommand | null {
  if (!record(value) || !keys(value, ['type', 'data']) || !record(value.data)) return null;
  const data = value.data;
  switch (value.type) {
    case 'C2S_CREATE_ROOM':
      if (!keys(data, ['mode', 'difficulty']) || !QUANDI_MODES.some((mode) => mode === data.mode)
          || !QUANDI_DIFFICULTIES.some((difficulty) => difficulty === data.difficulty)) return null;
      return { type: value.type, data: { mode: data.mode as QuandiMode, difficulty: data.difficulty as QuandiDifficulty } };
    case 'C2S_JOIN_ROOM':
      return keys(data, ['roomCode']) && typeof data.roomCode === 'string' && /^[A-HJ-NP-Z2-9]{6}$/.test(data.roomCode)
        ? { type: value.type, data: { roomCode: data.roomCode } } : null;
    case 'C2S_SET_READY':
      return keys(data, ['isReady']) && typeof data.isReady === 'boolean' ? { type: value.type, data: { isReady: data.isReady } } : null;
    case 'C2S_PLAYER_INPUT': {
      if (!keys(data, ['direction', 'seq']) || !record(data.direction) || !keys(data.direction, ['x', 'y'])
          || !Number.isSafeInteger(data.seq) || (data.seq as number) < 1
          || ![-1, 0, 1].includes(data.direction.x as number) || ![-1, 0, 1].includes(data.direction.y as number)) return null;
      return { type: value.type, data: { direction: { x: data.direction.x as number, y: data.direction.y as number }, seq: data.seq as number } };
    }
    case 'C2S_START_GAME': case 'C2S_LEAVE_ROOM': case 'C2S_FORFEIT': case 'C2S_PING':
      return keys(data, []) ? { type: value.type, data: {} } : null;
    default: return null;
  }
}
