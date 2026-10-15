import { WAND_INPUT, WAND_RADIUS, WAND_SPEED, WAND_TILES } from './protocol.js';

export function wandPositionBlocked(x: number, y: number): boolean {
  for (let row = Math.floor((y - WAND_RADIUS) / 50); row <= Math.floor((y + WAND_RADIUS) / 50); row++) {
    for (let column = Math.floor((x - WAND_RADIUS) / 50); column <= Math.floor((x + WAND_RADIUS) / 50); column++) {
      if (row < 0 || column < 0 || row >= 10 || column >= 10 || WAND_TILES[row][column] === 1) return true;
    }
  }
  return false;
}

export function stepWandPosition(position: { x: number; y: number }, buttons: number, elapsedSeconds: number) {
  let dx = Number(!!(buttons & WAND_INPUT.right)) - Number(!!(buttons & WAND_INPUT.left));
  let dy = Number(!!(buttons & WAND_INPUT.down)) - Number(!!(buttons & WAND_INPUT.up));
  if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  const dt = Math.max(0, Math.min(elapsedSeconds, .1));
  // 小步逐轴移动，卡顿也不穿过湖泊或地图边缘。
  const steps = Math.max(1, Math.ceil(WAND_SPEED * dt / 2));
  let { x, y } = position;
  for (let i = 0; i < steps; i++) {
    const nextX = x + dx * WAND_SPEED * dt / steps;
    if (!wandPositionBlocked(nextX, y)) x = nextX;
    const nextY = y + dy * WAND_SPEED * dt / steps;
    if (!wandPositionBlocked(x, nextY)) y = nextY;
  }
  return { x, y };
}
