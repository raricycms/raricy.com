import { useId, type CSSProperties } from 'react';
import { coordinate, type Color, type Level, type Mirror, type Point, type Trace } from './engine';

export const COLOR_NAMES = { gold: '金光', blue: '蓝光' };
const COLORS = { gold: '#ffca75', blue: '#73d9f5' };
export const MIRROR_NAMES = ['空位', '/ 镜片', '\\ 镜片'] as const;

function Symbol({ color }: { color: Color }) {
  return color === 'gold' ? <circle r="4" /> : <path d="M0-5 5 0 0 5-5 0Z" />;
}

export default function Board({ level, board, result, tool, ready, place }: {
  level: Level; board: Mirror[]; result: Trace; tool: Mirror; ready: boolean; place: (i: number, remove?: boolean) => void;
}) {
  const id = useId().replaceAll(':', '');
  const extent = level.size + 1.3;
  const position = (n: number) => n < 0 ? -.75 : n >= level.size ? level.size - .25 : n;
  const xy = (p: Point) => `${position(p.x) * 64},${position(p.y) * 64}`;
  return <div className="l2-board" data-level={level.id} data-solved={result.solved} data-tool={tool}>
    <svg className="l2-art" viewBox={`${-1.15 * 64} ${-1.15 * 64} ${extent * 64} ${extent * 64}`} role="img" aria-label={`第 ${level.id} 关光路，${result.lit.length} / ${level.targets.length} 个出口已接通`}>
      <defs><radialGradient id={`${id}-bg`}><stop stopColor="#203847" /><stop offset="1" stopColor="#10212d" /></radialGradient></defs>
      <rect x="-74" y="-74" width={extent * 64 + 2} height={extent * 64 + 2} fill={`url(#${id}-bg)`} />
      <g aria-hidden="true">
        {Array.from({ length: level.size }, (_, y) => Array.from({ length: level.size }, (_, x) => <circle key={`${x},${y}`} cx={x * 64} cy={y * 64} r="1.4" fill="#72909f" opacity=".26" />))}
        {result.beams.map((beam, i) => <g key={i} fill="none" stroke={COLORS[beam.color]} strokeLinecap="round" strokeLinejoin="round">
          <polyline points={beam.points.map(xy).join(' ')} strokeWidth="9" opacity=".07" />
          <polyline points={beam.points.map(xy).join(' ')} strokeWidth="2.5" strokeDasharray={beam.color === 'blue' ? '7 5' : undefined} opacity=".9" />
          <polyline className="l2-flow" points={beam.points.map(xy).join(' ')} strokeWidth="2" stroke="#fff" strokeDasharray="1 23" opacity=".65" />
        </g>)}
        {level.sockets.map((p, i) => <g key={i} transform={`translate(${p.x * 64} ${p.y * 64})`}>
          <circle className="l2-socket-ring" r="22" fill="#172f3d" fillOpacity={board[i] ? '.95' : '.55'} stroke="#7693a2" strokeOpacity={board[i] ? '.35' : '.24'} strokeDasharray={board[i] ? undefined : '2 5'} />
          {board[i] ? <g className="l2-mirror" style={{ transform: `rotate(${board[i] === 2 ? 90 : 0}deg)` }}>
            <path d="M-14 14 14-14" stroke="#e2f1ec" strokeWidth="5" strokeLinecap="round" /><path d="M-12 17 17-12" stroke="#86b4c8" strokeWidth="1.5" strokeLinecap="round" />
          </g> : <path d="M-4 0H4M0-4V4" stroke="#7895a3" strokeWidth="1.2" />}
          {result.shared.includes(i) && <g><circle cx="-16" cy="-19" r="3" fill={COLORS.gold} /><path d="m-7-22 3 3-3 3-3-3Z" fill={COLORS.blue} /></g>}
        </g>)}
        {level.sources.map((p, i) => <g key={`s${i}`} transform={`translate(${xy(p)})`} style={{ color: COLORS[p.color] }}>
          <circle r="17" fill="currentColor" fillOpacity=".16" /><g fill="currentColor"><Symbol color={p.color} /></g>
          <path d="m-4-21 4-5 4 5" transform={`rotate(${p.direction * 90})`} stroke="currentColor" strokeWidth="2" fill="none" />
        </g>)}
        {level.targets.map((p, i) => <g key={`t${i}`} transform={`translate(${xy(p)})`} style={{ color: COLORS[p.color] }}>
          <circle r="19" fill="currentColor" fillOpacity={result.lit.includes(i) ? '.22' : '.04'} stroke="currentColor" strokeWidth={result.lit.includes(i) ? 2.5 : 1.5} strokeDasharray={result.lit.includes(i) ? undefined : '2 4'} />
          <circle r="12" stroke="currentColor" strokeWidth="1" fill="none" opacity=".5" /><g fill={result.lit.includes(i) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"><Symbol color={p.color} /></g>
          {result.lit.includes(i) && <path d="m-4 25 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.5" />}
        </g>)}
      </g>
    </svg>
    {level.sockets.map((p, i) => <button key={i} className="l2-socket" data-socket={i} data-state={board[i]} type="button" disabled={!ready}
      aria-label={`${coordinate(p)}，${MIRROR_NAMES[board[i]]}${result.shared.includes(i) ? '，两束光共用' : ''}`} aria-pressed={board[i] > 0}
      style={{ left: `${(p.x + 1.15) / extent * 100}%`, top: `${(p.y + 1.15) / extent * 100}%`, width: `${.9 / extent * 100}%`, height: `${.9 / extent * 100}%` } as CSSProperties}
      onClick={() => place(i)} onContextMenu={(e) => { e.preventDefault(); place(i, true); }} onKeyDown={(e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); place(i, true); }
      }}><span aria-hidden="true">{tool === 0 ? '×' : tool === 1 ? '/' : '\\'}</span><small className="l2-coordinate" aria-hidden="true">{coordinate(p)}</small></button>)}
  </div>;
}
