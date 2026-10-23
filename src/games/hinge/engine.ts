// 人物与终点记录在「纸片 / 半间」上，而不是桌面坐标上。
// 平移和旋转只改变纸片姿态；跨门才会改变人物所在的半间。
export type Direction = 0 | 1 | 2 | 3;
export type RoomKind = 'slide' | 'pivot' | 'fixed';
export interface Place { room: string; chamber: number }
export interface Pose { x: number; y: number; turn: number }
export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  // 两个半间按未旋转时的左、右排列；端口方向为上、右、下、左。
  chambers: readonly (readonly Direction[])[];
  initial: Pose;
}
export interface Level {
  id: string;
  title: string;
  columns: number;
  rows: number;
  slots: readonly (readonly [number, number])[];
  rooms: readonly Room[];
  start: Place;
  goal: Place;
  hints: readonly string[];
  insight: string;
}
export interface State { poses: Record<string, Pose>; player: Place }
export type Action =
  | { type: 'walk'; direction: Direction }
  | { type: 'slide'; room: string; direction: Direction }
  | { type: 'rotate'; room: string; amount: 1 | -1 };

export const DIRECTIONS = [0, 1, 2, 3] as const;
export const DIRECTION_NAMES = ['上', '右', '下', '左'] as const;
export const DELTAS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
export const KINDS = { slide: '滑动纸片', pivot: '转动纸片', fixed: '固定房间' } as const;
export const mod4 = (n: number) => ((n % 4) + 4) % 4;

export function initialState(level: Level): State {
  return { poses: Object.fromEntries(level.rooms.map((r) => [r.id, { ...r.initial }])), player: { ...level.start } };
}
export function roomAt(level: Level, state: State, x: number, y: number): Room | undefined {
  return level.rooms.find((room) => state.poses[room.id].x === x && state.poses[room.id].y === y);
}
export function doors(room: Room, pose: Pose, chamber: number): Direction[] {
  return room.chambers[chamber].map((d) => mod4(d + pose.turn) as Direction);
}
export function isWon(level: Level, state: State): boolean {
  return state.player.room === level.goal.room && state.player.chamber === level.goal.chamber;
}

export function attempt(level: Level, state: State, action: Action): { state: State; error?: string } {
  const fail = (error: string) => ({ state, error });
  if (action.type === 'walk') {
    const room = level.rooms.find((r) => r.id === state.player.room)!;
    const pose = state.poses[room.id];
    if (!doors(room, pose, state.player.chamber).includes(action.direction)) return fail('这面是墙，人物走不过去。');
    const [dx, dy] = DELTAS[action.direction];
    const neighbor = roomAt(level, state, pose.x + dx, pose.y + dy);
    if (!neighbor) return fail('门外没有地板，需要有房间接上。');
    const opposite = mod4(action.direction + 2);
    const chamber = neighbor.chambers.findIndex((_, c) => doors(neighbor, state.poses[neighbor.id], c).some((d) => d === opposite));
    if (chamber < 0) return fail('相邻房间的门没有对齐。');
    return { state: { ...state, player: { room: neighbor.id, chamber } } };
  }
  const room = level.rooms.find((r) => r.id === action.room);
  if (!room) return fail('请先选中一张纸片。');
  const pose = state.poses[room.id];
  if (action.type === 'rotate') {
    if (room.kind !== 'pivot') return fail('只有带中央转轴的纸片可以旋转。');
    return { state: { ...state, poses: { ...state.poses, [room.id]: { ...pose, turn: pose.turn + action.amount } } } };
  }
  if (room.kind !== 'slide') return fail('这张纸片固定在底板上，不能平移。');
  const [dx, dy] = DELTAS[action.direction];
  const x = pose.x + dx, y = pose.y + dy;
  if (!level.slots.some(([sx, sy]) => sx === x && sy === y)) return fail('那里没有导轨槽位。');
  if (roomAt(level, state, x, y)) return fail('槽位已被占用，纸片只能滑入相邻空槽。');
  return { state: { ...state, poses: { ...state.poses, [room.id]: { ...pose, x, y } } } };
}

export function replay(level: Level, actions: readonly Action[]): State | null {
  let state = initialState(level);
  for (const action of actions) {
    const result = attempt(level, state, action);
    if (result.error) return null;
    state = result.state;
  }
  return state;
}

export function possibleActions(level: Level): Action[] {
  return [
    ...DIRECTIONS.map((direction): Action => ({ type: 'walk', direction })),
    ...level.rooms.flatMap((room): Action[] => room.kind === 'slide'
      ? DIRECTIONS.map((direction) => ({ type: 'slide', room: room.id, direction }))
      : room.kind === 'pivot' ? [{ type: 'rotate', room: room.id, amount: 1 }, { type: 'rotate', room: room.id, amount: -1 }] : []),
  ];
}

// 供关卡验证器去重；四次转动后的状态与转动前等价。
export function stateKey(level: Level, state: State): string {
  return level.rooms.map(({ id }) => {
    const p = state.poses[id];
    return `${p.x},${p.y},${mod4(p.turn)}`;
  }).join('|') + `|${state.player.room},${state.player.chamber}`;
}
