import type { Level, Room, State } from './engine';

export function HingeIcon() {
  return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="M5 9h16v30H5zM27 9h16v30H27zM21 16h6M21 32h6" strokeLinejoin="round" />
    <circle cx="13" cy="18" r="2" /><circle cx="35" cy="30" r="2" /><path d="M30 18h9M9 30h8" />
  </svg>;
}

function Pin({ x, y }: { x: number; y: number }) {
  return <g><circle cx={x} cy={y} r="3.2" fill="#ae834c" stroke="#71562f" strokeWidth="1" /><path d={`M${x - 1.5} ${y + 1.5}l3 -3`} stroke="#f3ddaa" strokeWidth="1.2" /></g>;
}

export function Pawn({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`}><ellipse cy="9" rx="10" ry="3.5" fill="#683f2b" opacity=".16" /><path d="M-6 7Q-7 0-3-2H3Q7 0 6 7Z" fill="#bd4837" stroke="#853c30" strokeWidth="1" /><circle cy="-7" r="5.2" fill="#d75f49" stroke="#853c30" strokeWidth="1" /><circle cx="-1.5" cy="-8.5" r="1.5" fill="#f5b6a1" /></g>;
}

export function Arch({ x, y }: { x: number; y: number }) {
  return <g transform={`translate(${x} ${y})`} fill="none" stroke="#38736a" strokeWidth="2.7" strokeLinejoin="round">
    <path d="M-8 10V-3a8 8 0 0 1 16 0v13M-11 10h22M-4 10V-3a4 4 0 0 1 8 0v13" /><path d="M-2 3h4M0 1v4" strokeWidth="1.5" />
  </g>;
}

export function RoomDrawing({ room, state, level, selected = false }: { room: Room; state: State; level: Level; selected?: boolean }) {
  const pose = state.poses[room.id];
  const ports = room.chambers.flat();
  const split = room.chambers.length === 2;
  const cx = (chamber: number) => split ? chamber === 0 ? 28 : 72 : 50;
  return <svg viewBox="0 0 100 100" aria-hidden="true" className="hy-room-art">
    {/* 导轨与转轴属于底板，房内的墙、棋子和终点属于旋转纸片。 */}
    {room.kind === 'slide' && <g stroke="#a69c8c" strokeWidth="1" opacity=".8"><path d="M1 8v84M99 8v84M8 1h84M8 99h84" /><path d="M0 25h3M0 50h3M0 75h3M97 25h3M97 50h3M97 75h3" /></g>}
    <g className="hy-room-paper" style={{ transform: `rotate(${pose.turn * 90}deg)` }}>
      <rect x="6" y="8" width="88" height="88" rx="3" fill="#af9c7d" opacity=".3" />
      <rect x="5" y="4" width="90" height="90" rx="3" fill={selected ? '#f7efd8' : '#eee5d4'} />
      <path d="M87 4h8v8" fill="#dfd1b9" />
      <rect x="14" y="14" width={split ? 32 : 72} height="72" rx="3" fill="#e5d6bc" />
      {split && <rect x="54" y="14" width="32" height="72" rx="3" fill="#d3e0d7" />}
      <g stroke="#b29e7e" strokeWidth=".65" opacity=".6">
        <path d="M20 22h14M20 27h8M20 73v7h7" />
        {split ? <g fill="#8d9f91" stroke="none"><circle cx="66" cy="23" r="1.5" /><circle cx="73" cy="23" r="1.5" /><circle cx="80" cy="23" r="1.5" /><circle cx="73" cy="29" r="1.5" /><circle cx="80" cy="29" r="1.5" /></g> : <path d="M65 73h14M73 78h6" />}
      </g>
      <g fill="none" stroke={selected ? '#655b47' : '#756751'} strokeWidth="3.6" strokeLinecap="square">
        {[0, 1, 2, 3].map((d) => <path key={d} transform={`rotate(${d * 90} 50 50)`} d={ports.includes(d as 0 | 1 | 2 | 3) ? 'M10 10H37M63 10H90' : 'M10 10H90'} />)}
        {split && <path d="M50 10v80" strokeWidth="4.4" />}
      </g>
      {ports.map((d) => <g key={d} transform={`rotate(${d * 90} 50 50)`}>
        <path d="M38 2h24v16H38z" fill="#e9d8b5" /><path d="M38 4v13M62 4v13" stroke="#9f8660" strokeWidth="1.4" /><path d="M43 7h14M43 12h14" stroke="#bda987" strokeWidth=".7" />
      </g>)}
      {level.goal.room === room.id && <Arch x={cx(level.goal.chamber)} y={50} />}
      {state.player.room === room.id && <Pawn x={cx(state.player.chamber)} y={room.kind === 'pivot' && !split ? 68 : level.goal.room === room.id && state.player.chamber === level.goal.chamber ? 54 : 50} />}
      {room.kind === 'fixed' && <><Pin x={17} y={17} /><Pin x={83} y={83} /></>}
    </g>
    {room.kind === 'pivot' && <g><circle cx="50" cy="50" r="4.5" fill="#e3c482" stroke="#957044" strokeWidth="1.5" /><path d="M48 52l4-4" stroke="#7a582f" strokeWidth="1.2" /></g>}
    {selected && <g stroke="#337c9f" strokeWidth="2.8" fill="none"><path d="M4 17V4h13M83 4h13v13M96 83v13H83M17 96H4V83" /></g>}
  </svg>;
}

export function MainPreview({ level, state }: { level: Level; state: State }) {
  return <svg viewBox={`0 0 ${level.columns * 30} ${level.rows * 30}`} aria-hidden="true" className="hy-mini-map">
    {level.slots.map(([x, y]) => <rect key={`${x},${y}`} x={x * 30 + 2} y={y * 30 + 2} width="26" height="26" rx="3" fill="currentColor" opacity=".12" />)}
    {level.rooms.map((room) => { const p = state.poses[room.id]; return <g key={room.id} transform={`translate(${p.x * 30} ${p.y * 30}) scale(.3)`}><RoomDrawing level={level} room={room} state={state} /></g>; })}
  </svg>;
}
