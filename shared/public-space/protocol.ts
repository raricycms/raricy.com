// 页面与实时进程共用的零依赖契约；位置以 0–24 表示，null 表示观众席。
export const PUBLIC_SPACE_SIZE = 5;
export const PUBLIC_SPACE_CELLS = PUBLIC_SPACE_SIZE * PUBLIC_SPACE_SIZE;
export const PUBLIC_SPACE_HEARTBEAT_MS = 5_000;
export const PUBLIC_SPACE_TIMEOUT_MS = 15_000;
export const PUBLIC_SPACE_MAX_USERS = 128;

export interface PublicSpaceUser {
  userId: string;
  name: string;
  frameUrl: string | null;
  cell: number | null;
}
export interface PublicSpaceSnapshot {
  type: 'public-space.snapshot';
  users: PublicSpaceUser[];
}
export type PublicSpaceCommand =
  | { type: 'public-space.move'; cell: number | null }
  | { type: 'public-space.ping' };

export function isPublicSpaceCell(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < PUBLIC_SPACE_CELLS;
}

export function parsePublicSpaceCommand(value: unknown): PublicSpaceCommand | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'public-space.ping') return { type: message.type };
  if (message.type !== 'public-space.move' || (message.cell !== null && !isPublicSpaceCell(message.cell))) return null;
  return { type: message.type, cell: message.cell as number | null };
}

export function parsePublicSpaceSnapshot(value: unknown): PublicSpaceSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'public-space.snapshot' || !Array.isArray(message.users) || message.users.length > PUBLIC_SPACE_MAX_USERS) return null;
  const ids = new Set<string>(), cells = new Set<number>();
  for (const user of message.users) {
    if (!user || typeof user !== 'object' || typeof user.userId !== 'string' || !user.userId
      || typeof user.name !== 'string' || !user.name
      || (user.frameUrl !== null && typeof user.frameUrl !== 'string')
      || (user.cell !== null && !isPublicSpaceCell(user.cell)) || ids.has(user.userId)) return null;
    ids.add(user.userId);
    if (user.cell !== null) {
      if (cells.has(user.cell)) return null;
      cells.add(user.cell);
    }
  }
  return { type: 'public-space.snapshot', users: message.users };
}
