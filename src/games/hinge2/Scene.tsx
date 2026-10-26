'use client';

import { useId, type KeyboardEvent } from 'react';
import { graph, transform, type Level, type Node, type Point, type Pose, type State, type Surface } from './engine';

export type ScreenPoint = { x: number; y: number };
export function project(p: Point): ScreenPoint { return { x: 480 + (p.x - p.y) * 57, y: 338 + (p.x + p.y) * 28.5 - (p.z ?? 0) * 57 }; }
const pts = (points: Point[]) => points.map((p) => { const q = project(p); return `${q.x},${q.y}`; }).join(' ');
const lift = (p: Point, z: number): Point => ({ ...p, z: (p.z ?? 0) + z });

function Block({ corners, depth = .42, tone = 'stone' }: { corners: Point[]; depth?: number; tone?: string }) {
  const bottom = corners.map((p) => lift(p, -depth));
  return <g className={`h2-block h2-block--${tone}`}>
    {corners.map((p, i) => <polygon key={i} className={i % 2 ? 'h2-block-side' : 'h2-block-front'} points={pts([p, corners[(i + 1) % corners.length], bottom[(i + 1) % corners.length], bottom[i]])} />)}
    <polygon className="h2-block-top" points={pts(corners)} />
  </g>;
}
function PathBlock({ a, b, reflection }: { a: Point; b: Point; reflection: boolean }) {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  const vx = -dy / length * .18, vy = dx / length * .18;
  const corners = [{ ...a, x: a.x + vx, y: a.y + vy }, { ...b, x: b.x + vx, y: b.y + vy }, { ...b, x: b.x - vx, y: b.y - vy }, { ...a, x: a.x - vx, y: a.y - vy }].map((p) => lift(p, .36));
  return <g><Block corners={corners} depth={reflection ? .15 : .42} tone={reflection ? 'glass' : 'stone'} />
    <polyline className={reflection ? 'h2-glass-line' : 'h2-path-line'} points={pts([lift(a, .38), lift(b, .38)])} />
  </g>;
}
function Pedestal({ p, goal = false }: { p: Point; goal?: boolean }) {
  const corners = [[-.43, -.43], [.43, -.43], [.43, .43], [-.43, .43]].map(([x, y]) => ({ x: p.x + x, y: p.y + y, z: .36 }));
  const q = project(lift(p, .38));
  return <g><Block corners={corners} depth={1.55} tone="ivory" />
    <path d={`M${q.x - 12} ${q.y + 33}v34m12-29v35m12-29v34`} stroke="#a5a7a0" strokeWidth="2" opacity=".3" />
    {goal && <g transform={`translate(${q.x} ${q.y})`} className="h2-gate">
      <path d="M-22 4V-45a22 22 0 0 1 44 0V4h-9v-49a13 13 0 0 0-26 0V4Z" fill="#f9f1dc" />
      <path d="M22 4l9-5v-48c0-14-8-24-20-26l-11 5c13 0 22 10 22 25Z" fill="#b8b7ac" />
      <path d="M-13 2v-47a13 13 0 0 1 26 0V2Z" className="h2-door-light" />
      <path d="M-28 6h56l7 5h-56Z" fill="#fff7e5" />
      <circle cy="-79" r="4" fill="#c8a36a" /><path d="M0-92v-7m-13 16h-7m33 0h7" stroke="#c8a36a" strokeWidth="1.5" />
    </g>}
  </g>;
}
function Pavilion({ p, variant = 0 }: { p: Point; variant?: number }) {
  const q = project(p);
  return <g transform={`translate(${q.x} ${q.y})`} className="h2-pavilion" opacity={variant ? .7 : 1}>
    <path d="M-24 2 0 14 24 2 0-10Z" fill="#e5d2ac" />
    <path d="M-17-5v-47l7 3v47m20 0v-47l7-3v47" fill="#d6cfb7" />
    <path d="M-10-2v-45l10 5v46m0 0v-46l10-5v45" fill="#f7eed8" />
    <path d="M-27-56 0-70 27-56 0-42Z" fill="#fbf1d9" />
    <path d="M-27-56v8L0-34v-8m0 8 27-14v-8L0-42" fill="#bfb99e" />
    <path d="M-19-61 0-94 19-61 0-51Z" fill="#be9c79" /><path d="M0-94v43l19-10Z" fill="#9b8269" />
    <circle cy="-98" r="3" fill="#d4ba8a" />
  </g>;
}
function Tree({ p }: { p: Point }) {
  const q = project(p);
  return <g transform={`translate(${q.x} ${q.y})`}><ellipse cy="5" rx="15" ry="6" fill="#3d6d69" opacity=".1" /><path d="M0 2v-39" stroke="#718179" strokeWidth="3" /><path d="M0-68C-19-42-18-12 0-10 18-12 19-42 0-68" fill="#72968b" /><path d="M0-68v58C18-12 19-42 0-68" fill="#5e817a" /></g>;
}
export function Pawn({ p }: { p: Point }) {
  const q = project(lift(p, .4));
  return <g className="h2-pawn" transform={`translate(${q.x} ${q.y})`} pointerEvents="none">
    <ellipse cy="4" rx="10" ry="4" fill="#574b51" opacity=".18" />
    <path d="M-3-6-4 3m8-9L4 3" stroke="#a44a43" strokeWidth="3" strokeLinecap="round" />
    <path d="M0-28C-5-25-7-13-9-6Q0-2 9-6C6-14 5-25 0-28" fill="#c96958" />
    <path d="M0-28v24q5 0 9-2C6-14 5-25 0-28" fill="#ab514c" />
    <circle cy="-30" r="6" fill="#fff5dd" /><path d="m-9-32 9-20 9 20Z" fill="#fff7e8" /><path d="m0-52 9 20H0Z" fill="#d9d7cc" />
    <path d="M-4-20q-13 5-17-3" stroke="#edb389" fill="none" strokeWidth="3" strokeLinecap="round" />
  </g>;
}

type Props = { level: Level; state: State; pose: Pose; pawn: Point; busy: boolean; onWalk: (id: string) => void; onMechanism: (type: 'turn' | 'mirror' | 'fold') => void };

export default function Scene({ level, state, pose, pawn, busy, onWalk, onMechanism }: Props) {
  const uid = useId().replace(/:/g, '');
  const p = (point: Point, surface: Surface = 'paper') => transform(point, surface, pose);
  const nodePosition = (node: Node) => p(node, node.surface);
  const leftPaper = [{ x: -3.45, y: -3.45 }, { x: 0, y: -3.45 }, { x: 0, y: 3.45 }, { x: -3.45, y: 3.45 }].map((v) => lift(p(v), -.12));
  const rightPaper = [{ x: 0, y: -3.45 }, { x: 3.45, y: -3.45 }, { x: 3.45, y: 3.45 }, { x: 0, y: 3.45 }].map((v) => lift(p(v, 'wing'), -.12));
  const allNodes = new Map(level.nodes.map((node) => [node.id, node]));
  const links = graph(level, state);
  const connected = new Set<string>();
  for (const node of level.nodes) {
    if (links.get(node.id)?.some((id) => allNodes.get(id)!.surface !== node.surface)) connected.add(node.id);
  }
  const interact = (action: () => void) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!busy) action(); }
  };
  const mirA = p({ x: 0, y: -2.4 }), mirB = p({ x: 0, y: 2.4 });
  const angle = Math.PI / 2 - pose.mirror * Math.PI / 4;
  const mirrorEnds = [-1, 1].map((d) => p({ x: Math.cos(angle) * 1.45 * d, y: Math.sin(angle) * 1.45 * d }));
  const wheel = project({ x: .45, y: 4.65, z: -.1 });
  const foldPoint = project(p({ x: 3.38, y: 2.5 }, 'wing'));
  const mirrorPoint = project(lift(p({ x: 0, y: 0 }), 1.05));
  const hasMirror = level.mechanics.includes('mirror'), hasFold = level.mechanics.includes('fold');
  const edges = level.edges.map(([a, b]) => ({ a: allNodes.get(a)!, b: allNodes.get(b)! })).sort((a, b) => {
    const pa = nodePosition(a.a), pb = nodePosition(b.a);
    return pa.x + pa.y - pb.x - pb.y;
  });

  return <svg className="h2-scene" viewBox="0 0 960 700" aria-label={`${level.title}立体纸景，点击圆点行走`}>
    <defs>
      <radialGradient id={`${uid}-halo`}><stop stopColor={level.color} stopOpacity=".2" /><stop offset="1" stopColor={level.color} stopOpacity="0" /></radialGradient>
      <pattern id={`${uid}-grain`} width="13" height="13" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".65" fill="#9d8f76" opacity=".17" /><circle cx="9" cy="7" r=".4" fill="#9d8f76" opacity=".14" /></pattern>
      <linearGradient id={`${uid}-mirror`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e6fffa" stopOpacity=".12" /><stop offset=".5" stopColor="#93d9d2" stopOpacity=".55" /><stop offset="1" stopColor="#e6fffa" stopOpacity=".12" /></linearGradient>
    </defs>
    <ellipse cx="480" cy="365" rx="440" ry="270" fill={`url(#${uid}-halo)`} />
    <ellipse cx="480" cy="431" rx="315" ry="150" className="h2-ground-shadow" />
    <ellipse cx="480" cy="402" rx="395" ry="196" fill="none" className="h2-orbit" strokeDasharray="2 10" />
    <g aria-hidden="true">
      <Block corners={leftPaper} depth={.11} tone="paper" />
      <Block corners={rightPaper} depth={.11} tone={state.folded ? 'folded' : 'paper'} />
      <polygon points={pts(leftPaper)} fill={`url(#${uid}-grain)`} /><polygon points={pts(rightPaper)} fill={`url(#${uid}-grain)`} />
      <polyline points={pts([lift(mirA, -.1), lift(mirB, -.1)])} stroke="#b5a582" strokeWidth="1.4" strokeDasharray="5 7" opacity=".7" />
      {/* Small structures belong to the sheet, so turning and folding carry them too. */}
      <Pavilion p={p({ x: -2.25, y: -2.35 })} />
      {!hasFold && <Pavilion p={p({ x: 2.4, y: 2.35 })} variant={1} />}
      <Tree p={p({ x: -2.9, y: -1.55 })} /><Tree p={p({ x: -1.8, y: -2.7 })} />
      <Tree p={p({ x: 2.95, y: 2.4 }, hasFold ? 'wing' : 'paper')} />
      {[0, 1, 2, 3].map((i) => <Block key={i} corners={[{ x: -.6 + i * .19, y: -2.8 }, { x: -.41 + i * .19, y: -2.8 }, { x: -.41 + i * .19, y: -2.05 }, { x: -.6 + i * .19, y: -2.05 }].map((v) => lift(p(v, 'paper'), i * .09))} depth={.2 + i * .09} tone="ivory" />)}
      {hasMirror && <g className="h2-mirror-source"><polyline points={pts([{ x: 2, y: 0 }, { x: 2, y: -2 }, { x: 1, y: -2 }].map((v) => lift(p(v), .04)))} /><circle cx={project(p({ x: 2, y: -2 })).x} cy={project(p({ x: 2, y: -2 })).y} r="5" /></g>}
      {level.nodes.filter((node) => node.id === level.start || node.id === level.goal).map((node) => <Pedestal key={node.id} p={nodePosition(node)} goal={node.id === level.goal} />)}
      {edges.map(({ a, b }) => <PathBlock key={`${a.id}-${b.id}`} a={nodePosition(a)} b={nodePosition(b)} reflection={a.surface === 'reflection'} />)}
      {level.nodes.filter((node) => node.seal).map((node) => {
        const q = project(lift(nodePosition(node), .4));
        return <g key={node.id} transform={`translate(${q.x} ${q.y})`} className={state.seals.includes(node.id) ? 'h2-seal is-collected' : 'h2-seal'}><ellipse cy="0" rx="16" ry="8" /><path d="M0-34 8-22 0-10-8-22Z" /><path d="M0-29v14" stroke="#fff5ce" /></g>;
      })}
    </g>
    {hasMirror && <g className="h2-mirror-wall" pointerEvents="none" aria-hidden="true">
      <polygon points={pts([lift(mirrorEnds[0], .25), lift(mirrorEnds[1], .25), lift(mirrorEnds[1], 1.9), lift(mirrorEnds[0], 1.9)])} fill={`url(#${uid}-mirror)`} stroke="#83b9b6" strokeWidth="2" />
      <polyline points={pts([lift(mirrorEnds[0], .25), lift(mirrorEnds[0], 1.9), lift(mirrorEnds[1], 1.9), lift(mirrorEnds[1], .25)])} fill="none" stroke="#d7d9b8" strokeWidth="4" />
    </g>}
    {level.nodes.map((node) => {
      const q = project(lift(nodePosition(node), .39));
      return <g key={node.id} className={`h2-landing${connected.has(node.id) ? ' is-connected' : ''}${node.surface === 'reflection' ? ' is-reflection' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} aria-label={`走到${node.name}${node.surface === 'reflection' ? '（倒影）' : node.surface === 'wing' ? '（右半页）' : ''}`} data-node={node.id} onClick={() => { if (!busy) onWalk(node.id); }} onKeyDown={interact(() => onWalk(node.id))} transform={`translate(${q.x} ${q.y})`}>
        <circle r="21" className="h2-landing-hit" /><ellipse rx="6.5" ry="3.5" className="h2-landing-dot" /><ellipse rx="12" ry="6" className="h2-landing-ring" />
      </g>;
    })}
    <Pawn p={pawn} />
    {level.mechanics.includes('turn') && <g className="h2-handle h2-wheel" role="button" tabIndex={busy ? -1 : 0} aria-label="黄铜轮：顺时针转动整页" aria-disabled={busy} onClick={() => { if (!busy) onMechanism('turn'); }} onKeyDown={interact(() => onMechanism('turn'))} transform={`translate(${wheel.x} ${wheel.y})`}>
      <circle r="38" fill="transparent" /><ellipse cy="4" rx="29" ry="15" fill="#ac865e" /><ellipse rx="29" ry="15" fill="#e0c18c" stroke="#b29369" strokeWidth="1.5" /><g transform={`scale(1 .52) rotate(${pose.turn * 90})`}><circle r="21" fill="none" stroke="#9f7f59" strokeWidth="1.5" />{[0, 90, 180, 270].map((a) => <path key={a} d="M8 0H25" transform={`rotate(${a})`} stroke="#9f7f59" strokeWidth="3" />)}<circle r="8" fill="#b29369" /></g><text y="48">转动整页 ↻</text>
    </g>}
    {hasMirror && <g className="h2-handle h2-mirror-handle" role="button" tabIndex={busy ? -1 : 0} aria-label="镜面机关：转动镜面" aria-disabled={busy} onClick={() => { if (!busy) onMechanism('mirror'); }} onKeyDown={interact(() => onMechanism('mirror'))} transform={`translate(${mirrorPoint.x} ${mirrorPoint.y - 73})`}>
      <circle r="24" className="h2-handle-disc" /><path d="M-8 9V-7l16-5V5Z" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m-4 2 8-5" stroke="currentColor" /><text y="41">转动镜面</text>
    </g>}
    {hasFold && <g className="h2-handle h2-fold-handle" role="button" tabIndex={busy ? -1 : 0} aria-label="折痕机关：对折或展开右半页" aria-disabled={busy} onClick={() => { if (!busy) onMechanism('fold'); }} onKeyDown={interact(() => onMechanism('fold'))} transform={`translate(${foldPoint.x} ${foldPoint.y + 26})`}>
      <circle r="26" className="h2-handle-disc" /><path d="m-10-7 10 4 10-8V7L0 13-10 9Z M0-3v16" fill="none" stroke="currentColor" strokeWidth="1.5" /><text y="44">{state.folded ? '展开右页' : '沿线对折'}</text>
    </g>}
    <g aria-hidden="true" className="h2-compass" transform="translate(846 590)"><path d="M0-24 8 0 0-5-8 0Z" fill="currentColor" /><path d="M0 24 8 0 0 5-8 0Z" fill="currentColor" opacity=".3" /><text y="-34">N</text></g>
  </svg>;
}
