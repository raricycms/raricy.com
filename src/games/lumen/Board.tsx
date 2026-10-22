import { useId, type CSSProperties } from 'react';
import { isRotatable, type Level, type Light, type Piece, type Trace } from './engine';

export const LIGHT_NAMES: Record<Light, string> = { 1: '金光', 2: '蓝光', 3: '双光' };
const COLORS = { 1: '#ffc66e', 2: '#73d8ff', 3: '#e3bdff' };

function Mark({ color }: { color: Light }) {
  return color === 1 ? <circle r="4" /> : color === 2 ? <path d="m0-5 5 5-5 5-5-5Z" /> : <><circle cx="-4" r="3" /><path d="m4-4 4 4-4 4-4-4Z" /></>;
}

export function PieceArt({ piece, rotation, received = 0 }: { piece: Piece; rotation: number; received?: number }) {
  const color = COLORS[piece.color ?? 1];
  if (piece.kind === 'wall') return <><rect x="-23" y="-23" width="46" height="46" rx="9" fill="#233747" /><path d="m-12 12 24-24m-24 12 12-12m0 24 12-12" stroke="#405566" strokeWidth="2" /></>;
  if (piece.kind === 'portal') return <g className="lm-portal"><circle r="20" fill="#b7a0ff" fillOpacity=".09" stroke="#b7a0ff" strokeWidth="2" strokeDasharray="5 5" /><circle r="13" fill="none" stroke="#b7a0ff" strokeOpacity=".4" /><text y="5" textAnchor="middle" fill="#e2d7ff" fontSize="14">{piece.pair}</text></g>;
  if (piece.kind === 'source') return <g style={{ color }}>
    <circle r="22" fill={color} fillOpacity=".1" /><circle r="14" fill={color} fillOpacity=".25" stroke={color} strokeWidth="2" />
    <g fill={color}><Mark color={piece.color!} /></g>
    <path d="m-4-23 4-5 4 5" fill="none" stroke={color} strokeWidth="2" transform={`rotate(${(piece.direction ?? 0) * 90})`} />
  </g>;
  if (piece.kind === 'receiver') {
    const lit = received === piece.color;
    const wrong = received > 0 && !lit;
    return <g className={lit ? 'lm-receiver-lit' : ''} style={{ color }}>
      <circle r="22" fill={lit ? color : '#101e2d'} fillOpacity={lit ? .2 : 1} stroke={color} strokeWidth={lit ? 3 : 1.5} strokeDasharray={lit ? undefined : '3 5'} />
      <circle r="15" fill="none" stroke={color} strokeOpacity={lit ? 1 : .35} />
      <g fill={lit ? color : 'none'} stroke={color} strokeWidth="1.7"><Mark color={piece.color!} /></g>
      {wrong && <path d="m13-19 6 6m0-6-6 6" stroke="#ffaaa3" strokeWidth="2" />}
      {lit && <path d="m-6 28 4 4 8-8" fill="none" stroke={color} strokeWidth="2" />}
    </g>;
  }
  return <g>
    <circle r="22" fill={piece.fixed ? '#172738' : '#263c50'} />
    <circle r="17" fill="none" stroke="#6d899e" strokeOpacity=".28" />
    <g className="lm-mirror-line" style={{ transform: `rotate(${rotation * 90}deg)` }}>
      <path d="m-16 16 32-32" stroke={piece.kind === 'splitter' ? '#b5a5ff' : '#c6eeff'} strokeWidth="5" strokeLinecap="round" strokeDasharray={piece.kind === 'splitter' ? '4 7' : undefined} />
      <path d="m-12 17 29-29" stroke="#68afca" strokeOpacity=".35" strokeWidth="2" strokeLinecap="round" />
    </g>
    {piece.fixed ? <circle cx="0" cy="0" r="3" fill="#101e2d" stroke="#9bb1c0" /> : <path d="M12-22h7v7" stroke="#9eb9cc" fill="none" strokeWidth="1.5" />}
  </g>;
}

export function Board({ level, rotations, result, hint, rotate, ready }: {
  level: Level; rotations: number[]; result: Trace; hint: number | null; rotate: (index: number) => void; ready: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const size = level.size * 64;
  // Merge coincident segments, including opposite directions. Shared light has
  // its own pattern; color is never the only signal for a dual-color path.
  const paths = new Map<string, { x1: number; y1: number; x2: number; y2: number; color: number }>();
  result.segments.forEach((s) => {
    const a = `${s.x1},${s.y1}`, b = `${s.x2},${s.y2}`;
    const key = [a, b].sort().join('|');
    const previous = paths.get(key);
    paths.set(key, { ...s, color: (previous?.color ?? 0) | s.color });
  });
  return <div className="lm-board" data-level={level.id} data-solved={result.solved} style={{ '--lm-size': level.size } as CSSProperties}>
    <svg className="lm-board-art" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`第 ${level.id} 关光路，已点亮 ${result.lit} 个，共 ${result.total} 个接收器`}>
      <defs>
        <pattern id={`${id}-grid`} width="64" height="64" patternUnits="userSpaceOnUse"><path d="M64 0H0V64" fill="none" stroke="#9eb9cc" strokeOpacity=".055" /><circle cx="32" cy="32" r="1.3" fill="#607b91" fillOpacity=".32" /></pattern>
        <radialGradient id={`${id}-bg`}><stop stopColor="#20384d" /><stop offset="1" stopColor="#101e2e" /></radialGradient>
        <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <rect width={size} height={size} fill={`url(#${id}-bg)`} /><rect width={size} height={size} fill={`url(#${id}-grid)`} />
      <g aria-hidden="true" className="lm-rays">
        {[...paths.entries()].map(([key, s]) => {
          const d = `M${s.x1 * 64 + 32} ${s.y1 * 64 + 32}L${s.x2 * 64 + 32} ${s.y2 * 64 + 32}`;
          return <g key={key} fill="none" stroke={COLORS[s.color as Light]}>
            <path d={d} strokeWidth="8" opacity=".22" filter={`url(#${id}-glow)`} />
            <path d={d} strokeWidth={s.color === 3 ? 3 : 2} opacity=".85" />
            <path className="lm-ray-flow" d={d} stroke="#fff" strokeWidth="1.5" strokeDasharray={s.color === 2 ? '2 9' : s.color === 3 ? '3 3' : '2 18'} opacity=".75" />
          </g>;
        })}
      </g>
      {level.pieces.map((piece, i) => <g key={i} transform={`translate(${piece.x * 64 + 32} ${piece.y * 64 + 32})`}><PieceArt piece={piece} rotation={rotations[i]} received={result.received[i]} /></g>)}
      <g fill="#829bb1" fontSize="8" fontFamily="monospace" opacity=".7">
        {Array.from({ length: level.size }, (_, i) => <text key={i} x={i * 64 + 5} y="11">{String.fromCharCode(65 + i)}</text>)}
        {Array.from({ length: level.size }, (_, i) => <text key={i} x="5" y={i * 64 + 28}>{i + 1}</text>)}
      </g>
    </svg>
    {level.pieces.map((piece, i) => isRotatable(piece) && <button key={i} type="button" className={`lm-optic${hint === i ? ' lm-optic--hint' : ''}`} style={{ left: `${piece.x / level.size * 100}%`, top: `${piece.y / level.size * 100}%` }}
      data-piece={i} disabled={!ready || result.solved} onClick={() => rotate(i)}
      aria-label={`${String.fromCharCode(65 + piece.x)}${piece.y + 1} ${piece.kind === 'splitter' ? '分光镜' : '镜片'}，当前${rotations[i] ? '反斜线' : '斜线'}，点击转动`}>
      {hint === i && <span className="lm-hint-marker" aria-hidden="true">↻</span>}
    </button>)}
  </div>;
}
