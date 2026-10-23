import type { Direction, Level, Room, RoomKind } from './engine';

const room = (id: string, name: string, kind: RoomKind, x: number, y: number, chambers: Direction[][]): Room =>
  ({ id, name, kind, initial: { x, y, turn: 0 }, chambers });
const grid = (w: number, h: number): [number, number][] =>
  Array.from({ length: w * h }, (_, n) => [n % w, Math.floor(n / w)]);

export const LEVELS: readonly Level[] = [
  {
    id: '01', title: '第一扇门', columns: 3, rows: 2, slots: grid(3, 2),
    rooms: [room('start', '起点房', 'fixed', 0, 0, [[1]]), room('bridge', '廊房', 'slide', 1, 1, [[1, 3]]), room('end', '终点房', 'fixed', 2, 0, [[3]])],
    start: { room: 'start', chamber: 0 }, goal: { room: 'end', chamber: 0 },
    hints: ['看一看三间房的门分别朝向哪里。', '中间的纸片可以沿导轨向上滑一格。', '把廊房移到上方空槽，然后让人物向右走两次。'],
    insight: '门对齐的那一刻，两间房就连在一起。',
  },
  {
    id: '02', title: '桥不够长', columns: 4, rows: 1, slots: grid(4, 1),
    rooms: [room('start', '起点房', 'fixed', 0, 0, [[1]]), room('bridge', '廊房', 'slide', 1, 0, [[1, 3]]), room('end', '终点房', 'fixed', 3, 0, [[3]])],
    start: { room: 'start', chamber: 0 }, goal: { room: 'end', chamber: 0 },
    hints: ['一张纸片填不满两个位置。路接不上时，你还能站在哪里？', '站进活动房间，再试着移动纸片。', '人物向右进入廊房；廊房向右滑一格；人物再向右走。'],
    insight: '房间可以载着人物一起移动。',
  },
  {
    id: '03', title: '转角', columns: 2, rows: 2, slots: [[0, 1], [1, 1], [1, 0]],
    rooms: [room('start', '起点房', 'fixed', 0, 1, [[1]]), room('corner', '转角房', 'pivot', 1, 1, [[2, 3]]), room('end', '终点房', 'fixed', 1, 0, [[2]])],
    start: { room: 'start', chamber: 0 }, goal: { room: 'end', chamber: 0 },
    hints: ['门洞和地板都画在同一张纸上。', '转角房需要同时接住左边和上边的门。', '把转角房顺时针转一次；人物向右，再向上。'],
    insight: '旋转改变门的朝向，纸上的东西会一起转动。',
  },
  {
    id: '04', title: '隔墙', columns: 2, rows: 1, slots: grid(2, 1),
    rooms: [room('wait', '候室', 'fixed', 0, 0, [[1]]), room('split', '分隔房', 'pivot', 1, 0, [[3], [1]])],
    start: { room: 'split', chamber: 0 }, goal: { room: 'split', chamber: 1 },
    hints: ['转动以后，你仍然站在哪块地毯上？', '如果转动时，你不在这张纸上呢？', '先向左进入候室，将分隔房转半圈，再向右走回去。'],
    insight: '同一扇外门，可以在转动后通向另一半房间。',
  },
  {
    id: '05', title: '等房间回来', columns: 3, rows: 2, slots: grid(3, 2),
    rooms: [room('split', '分隔房', 'slide', 0, 1, [[3], [1]]), room('wait', '转轴候室', 'pivot', 1, 1, [[3]])],
    start: { room: 'split', chamber: 1 }, goal: { room: 'split', chamber: 0 },
    hints: ['拱门标记也画在纸上。观察它所在半间的门朝向。', '人物可以在候室等待，让分隔房绕到候室的另一侧。', '向右进入候室；把分隔房依次向上、右、右、下滑动；候室转半圈，再向右走。'],
    insight: '人物留在候室，终点所在的半间可以被运回来。',
  },
  {
    id: 'main', title: '回到另一边', columns: 4, rows: 3,
    slots: [[0, 2], [1, 2], [2, 2], [3, 2], [1, 1], [2, 1], [3, 1], [2, 0]],
    rooms: [room('split', '分隔房', 'slide', 0, 2, [[3], [1]]), room('wait', '转轴候室', 'pivot', 2, 1, [[0]])],
    start: { room: 'split', chamber: 1 }, goal: { room: 'split', chamber: 0 },
    hints: ['这堵墙始终留在纸上。两个半间的门分别朝向哪里？', '先让人物所在的半间接上候室；离开纸片以后，再考虑拱门所在的半间。', '分隔房向右、上；候室逆时针转一次，人物向右走进去。分隔房再向下、右、右、上；候室转半圈，人物向右进入终点。'],
    insight: '你在不同的时刻，借用了同一张纸的两扇门。',
  },
];

export const MAIN_LEVEL = LEVELS[5];
export function levelById(id: string): Level { return LEVELS.find((level) => level.id === id) ?? LEVELS[0]; }
