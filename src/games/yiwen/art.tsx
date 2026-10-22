import { describe, type Figure, type Instruction } from './engine';

/** 甲、乙是原创笔画，不把语义写成按钮名；框在铭牌与可操作符号上完全同形。 */
export function Rune({ rune, framed = false }: Instruction) {
  return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {framed && <rect x="3" y="3" width="42" height="42" rx="3" strokeWidth="1.5" />}
    {rune === 'turn'
      ? <><path d="M15 32V16h18M24 16v17M24 25h9" /><circle cx="15" cy="36" r="1.3" fill="currentColor" stroke="none" /></>
      : <><path d="M15 14v20M25 14v20M15 21h18M25 29h8" /><circle cx="33" cy="14" r="1.3" fill="currentColor" stroke="none" /></>}
  </svg>;
}

export function YiwenIcon() { return <Rune rune="turn" framed />; }

export function Drawing({ value, label, extent = 4 }: { value: Figure; label: string; extent?: number }) {
  const unit = 168 / Math.max(extent, value.width, value.height);
  const x = (200 - value.width * unit) / 2, y = (200 - value.height * unit) / 2;
  return <svg className="yw-drawing" viewBox="0 0 200 200" role="img" aria-label={`${label}，${describe(value)}`}>
    <rect x={x} y={y} width={value.width * unit} height={value.height * unit} rx="2" fill="none" stroke="currentColor" strokeOpacity=".25" strokeDasharray="3 4" />
    {value.cells.map((cell, i) => <g key={i} transform={`translate(${x + (i % value.width + .5) * unit} ${y + (Math.floor(i / value.width) + .5) * unit})`}>
      <circle r="1" fill="currentColor" opacity=".18" />
      {cell === 4 ? <circle r={unit * .12} fill="currentColor" /> : cell !== null &&
        <path d="M0 10V-10M-7-3l7-7 7 7" transform={`rotate(${cell * 90}) scale(${unit / 42})`} fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
    </g>)}
  </svg>;
}
