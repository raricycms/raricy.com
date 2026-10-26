'use client';

import { useId, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { clippedHalf, flapMatrix, goalStatus, markKey, otherFace, reflected, signedDistance, type Crease, type Face, type Goal, type Level, type Mark, type Matrix, type Point, type State } from './engine';

export const INK_SHAPE = 'M-.32-.45H.34V-.23H-.08V-.05H.23V.17H-.08V.45H-.32Z';
const polygon = (points: Point[]) => points.map((p) => `${p.x},${p.y}`).join(' ');
const matrixString = (matrix: Matrix) => `${matrix[0]} ${matrix[2]} ${matrix[1]} ${matrix[3]} 0 0`;
export function Glyph({ matrix, color = 'red', outline = false }: { matrix: Matrix; color?: string; outline?: boolean }) {
  return <g transform={`matrix(${matrixString(matrix)})`} className={`h3-glyph h3-glyph--${color}${outline ? ' is-outline' : ''}`}><path d={INK_SHAPE} /><path className="h3-ink-grain" d="M-.23-.35h.25M-.25-.28h.08M-.26.04h.1M-.25.3h.07" /></g>;
}
function GoalDrawing({ goal, state }: { goal: Goal; state: State }) {
  const status = goalStatus(goal, state);
  return <g transform={`translate(${goal.x} ${goal.y})`} className={`h3-target h3-target--${status}`} data-target={`${goal.face}:${goal.x},${goal.y}`} data-status={status}>
    <path className="h3-target-corners" d="M-.63-.4v-.23h.23M.4-.63h.23v.23M.63.4v.23H.4M-.4.63h-.23V.4" />
    <Glyph matrix={goal.matrix} color={goal.color} outline />
    {status === 'matched' && <path className="h3-target-check" d="m.4-.83.12.12.24-.27" />}
  </g>;
}

type Props = {
  level: Level; state: State; face: Face; crease: Crease; progress: number; busy: boolean;
  onSelect: (id: string) => void; onFold: () => void; onPress: () => void;
  onDrag: (progress: number | null, commit?: 'fold' | 'unfold') => void;
};
export default function Paper({ level, state, face, crease, progress, busy, onSelect, onFold, onPress, onDrag }: Props) {
  const uid = useId().replace(/:/g, '');
  const paper = useRef<SVGGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; initial: number; progress: number; moved: boolean } | null>(null);
  const moving = clippedHalf(crease, crease.side), fixed = clippedHalf(crease, crease.side === 1 ? -1 : 1);
  const foldTransform = `matrix(${flapMatrix(crease, progress).join(' ')})`;
  const path = `M0 0H8V8H0Z ${level.holes.map((h) => `M${h.x - h.width / 2} ${h.y - h.height / 2}h${h.width}v${h.height}h${-h.width}Z`).join(' ')}`;
  const center = moving.reduce((p, q) => ({ x: p.x + q.x / moving.length, y: p.y + q.y / moving.length }), { x: 0, y: 0 });
  const corner = moving.slice().sort((p, q) => Math.abs(signedDistance(q, crease)) - Math.abs(signedDistance(p, crease)) || q.y + q.x - p.y - p.x)[0];
  const grip = { x: corner.x * .78 + center.x * .22, y: corner.y * .78 + center.y * .22 };
  const endpoint = reflected(grip, crease);
  const [a, b, c, d, e, f] = flapMatrix(crease, progress);
  const handle = { x: a * grip.x + c * grip.y + e, y: b * grip.x + d * grip.y + f };
  const pressPoint = { x: a * center.x + c * center.y + e, y: b * center.x + d * center.y + f + 1 };
  const topFace = progress > .5 ? otherFace(face) : face;
  const back = face === 'back';

  function key(action: () => void) { return (event: KeyboardEvent<SVGGElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!busy) action(); } }; }
  function pointerDown(event: PointerEvent<SVGGElement>) {
    if (busy || event.button !== 0) return;
    const ctm = paper.current?.getScreenCTM();
    if (!ctm) return;
    const from = new DOMPoint(grip.x, grip.y).matrixTransform(ctm), to = new DOMPoint(endpoint.x, endpoint.y).matrixTransform(ctm);
    drag.current = { x: event.clientX, y: event.clientY, vx: to.x - from.x, vy: to.y - from.y, initial: progress, progress, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
  }
  function pointerMove(event: PointerEvent<SVGGElement>) {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 5) return;
    start.moved = true;
    start.progress = Math.max(0, Math.min(1, start.initial + (dx * start.vx + dy * start.vy) / Math.max(1, start.vx ** 2 + start.vy ** 2)));
    onDrag(start.progress);
  }
  function pointerUp(event: PointerEvent<SVGGElement>) {
    const start = drag.current; drag.current = null;
    if (!start) return;
    event.stopPropagation();
    if (!start.moved) { onFold(); return; }
    const folded = start.progress >= .5;
    const wasFolded = start.initial >= .5;
    onDrag(null, folded !== wasFolded ? folded ? 'fold' : 'unfold' : undefined);
  }
  function sideContent(contentFace: Face, movingFace = false) {
    return <g className={`h3-paper-face h3-paper-face--${contentFace}`}>
      <path className="h3-paper-material" d={path} fillRule="evenodd" />
      <path d={path} fill={`url(#${uid}-texture)`} fillRule="evenodd" />
      <g clipPath={`url(#${uid}-sheet)`}>
        <path className="h3-margin-marks" d="M.35.7V.35H.7M7.3.35h.35V.7M7.65 7.3v.35H7.3M.7 7.65H.35V7.3" />
        {!movingFace && <g className="h3-paper-registration"><text x=".55" y="7.55">{contentFace === 'front' ? 'FRONT' : 'BACK'}</text><path d="M6.55 7.5h.8m-.4-.2v.4" /></g>}
        {level.goals.filter((goal) => goal.face === contentFace).map((goal, i) => <GoalDrawing key={i} goal={goal} state={state} />)}
        {state.ink.filter((mark) => mark.face === contentFace).map((mark: Mark) => <g key={markKey(mark)} transform={`translate(${mark.x} ${mark.y})`} className={`h3-mark${mark.wet ? ' is-wet' : ' is-dry'}`} data-ink={markKey(mark)} data-wet={mark.wet}>
          <Glyph matrix={mark.matrix} color={mark.color} />
          {mark.wet && <g className={`h3-wet-indicator h3-glyph--${mark.color}`}><path d="M-.56-.63q-.15.19 0 .2.15-.01 0-.2Z" /><circle cx="-.56" cy="-.49" r=".022" fill="#fff9ea" /></g>}
        </g>)}
      </g>
      {level.holes.map((hole, i) => <rect key={i} className="h3-hole-edge" x={hole.x - hole.width / 2} y={hole.y - hole.height / 2} width={hole.width} height={hole.height} />)}
    </g>;
  }
  const movingVisible = progress > .001;
  return <svg className="h3-paper-art" viewBox="-1 -1 10 10" aria-label="可折叠的双面纸张">
    <defs>
      <pattern id={`${uid}-desk`} width=".25" height=".25" patternUnits="userSpaceOnUse"><path d="M.25 0H0V.25" fill="none" stroke="#879c92" strokeWidth=".006" opacity=".3" /></pattern>
      <pattern id={`${uid}-texture`} width=".23" height=".2" patternUnits="userSpaceOnUse"><circle cx=".07" cy=".04" r=".006" fill="#9a876a" opacity=".2" /><path d="m.13.13.04.005" stroke="#b0a082" strokeWidth=".004" opacity=".3" /></pattern>
      <clipPath id={`${uid}-sheet`}><path d={path} fillRule="evenodd" clipRule="evenodd" /></clipPath>
      <clipPath id={`${uid}-fixed`}><polygon points={polygon(fixed)} /></clipPath>
      <clipPath id={`${uid}-moving`}><polygon points={polygon(moving)} /></clipPath>
      <filter id={`${uid}-shadow`} x="-.3" y="-.3" width="1.6" height="1.6"><feDropShadow dx="0" dy=".05" stdDeviation=".06" floodColor="#645c48" floodOpacity=".18" /></filter>
    </defs>
    <rect className="h3-desk" x="-.7" y="-.7" width="9.4" height="9.4" rx=".18" />
    <rect x="-.7" y="-.7" width="9.4" height="9.4" rx=".18" fill={`url(#${uid}-desk)`} />
    <g className="h3-desk-register" aria-hidden="true"><path d="M-.3 0H-.1M0-.3v.2M8.1 0h.2M8-.3v.2M-.3 8h.2M0 8.1v.2M8.1 8h.2M8 8.1v.2" /><text x="4" y="8.48">{state.fold ? 'CONTACT / 接触中' : 'PAPER / 双面纸'}</text></g>
    <g ref={paper} transform={back ? 'translate(8 0) scale(-1 1)' : undefined}>
      {movingVisible ? <g clipPath={`url(#${uid}-fixed)`}>{sideContent(face)}</g> : sideContent(face)}
      {movingVisible && <g transform={foldTransform} filter={`url(#${uid}-shadow)`}><g clipPath={`url(#${uid}-moving)`}>{sideContent(topFace, true)}</g></g>}
      {progress < .01 && level.creases.map((item) => {
        const points = clippedHalf(item, item.side).filter((p) => Math.abs(signedDistance(p, item)) < 1e-6);
        if (points.length < 2) return null;
        return <g key={item.id} className={`h3-crease${item.id === crease.id ? ' is-selected' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-label={`选择折痕 ${item.id}`} aria-pressed={item.id === crease.id} data-crease={item.id} onClick={() => { if (!busy) onSelect(item.id); }} onKeyDown={key(() => onSelect(item.id))}>
          <line className="h3-crease-hit" x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} />
          <line className="h3-crease-line" x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} />
          <g transform={`translate(${points[0].x} ${points[0].y})${back ? ' scale(-1 1)' : ''}`}><circle r=".19" /><text y=".065">{item.id}</text></g>
        </g>;
      })}
      {!busy && <g className="h3-fold-grip" role="button" tabIndex={0} aria-label={state.fold ? '拖动展开纸页' : '拖动折起纸页'} transform={`translate(${handle.x} ${handle.y})${back ? ' scale(-1 1)' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; onDrag(null); }} onKeyDown={key(onFold)}>
        <circle className="h3-fold-grip-hit" r=".48" /><circle className="h3-fold-grip-disc" r=".24" /><path d={state.fold ? 'm.08-.11-.12.11.12.11M-.04 0H.13' : 'm-.08-.11.12.11-.12.11M.04 0H-.13'} /><text y=".61">{state.fold ? '拖回展开' : '拖动对折'}</text>
      </g>}
      {state.fold && !state.fold.pressed && !busy && <g className="h3-press-pad" role="button" tabIndex={0} aria-label="点击折页压印" transform={`translate(${pressPoint.x} ${pressPoint.y})${back ? ' scale(-1 1)' : ''}`} onClick={onPress} onKeyDown={key(onPress)}>
        <rect x="-.65" y="-.25" width="1.3" height=".5" rx=".25" /><text y=".065">压一下</text>
      </g>}
    </g>
  </svg>;
}
