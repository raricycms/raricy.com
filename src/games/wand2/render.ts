import { ATTACK_MS, DIRECTIONS, TILE, TILES, WORLD_HEIGHT, WORLD_WIDTH, type Player, type Slime } from '../../../shared/wand2/protocol';
import type { Scene } from './motion';

export interface Assets { character: HTMLImageElement; attack: HTMLImageElement; world: HTMLImageElement }
export interface FloatText { x: number; y: number; text: string; at: number }
const palette = ['#b8cfaa', '#b5cca7', '#bdd1b0', '#b9cdaa'];
const noise = (x: number, y: number) => ((x * 73 + y * 137 + x * y * 11) % 101) / 101;
// 未联机时草地上的静态预览：与联机时同一个绘制函数，免得「开始联机」前后换一种画风。
const PREVIEW_PLAYERS: Player[] = [{ id: 'preview', name: '', x: 100, y: 320, facing: 0, moving: false, attack: 0, hurt: 0, catnip: 0 }];
const PREVIEW_SLIMES: Slime[] = [
  { id: 0, x: 340, y: 230, kind: 0, hp: 2, mood: 'wander', phase: 0 },
  { id: 1, x: 440, y: 390, kind: 1, hp: 2, mood: 'wander', phase: 0 },
  { id: 2, x: 690, y: 300, kind: 2, hp: 3, mood: 'wander', phase: 0 },
];

function sprite(ctx: CanvasRenderingContext2D, sheet: HTMLImageElement, col: number, row: number, x: number, y: number, size: number) {
  if (!sheet.complete || !sheet.naturalWidth) return;
  const sw = sheet.naturalWidth / 4, sh = sheet.naturalHeight / 4;
  ctx.drawImage(sheet, col * sw, row * sh, sw, sh, x - size / 2, y - size * .9, size, size);
}
function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
}
export function makeGround(assets: Assets): HTMLCanvasElement {
  const layer = document.createElement('canvas'); layer.width = WORLD_WIDTH; layer.height = WORLD_HEIGHT;
  const c = layer.getContext('2d')!;
  for (let y = 0; y < TILES.length; y++) for (let x = 0; x < TILES[y].length; x++) {
    const n = noise(x, y), tile = TILES[y][x];
    c.fillStyle = tile === 2 ? ['#d8d0b8', '#d4ccb4', '#d9d1bb'][Math.floor(n * 3)] : palette[Math.floor(n * 4)];
    c.fillRect(x * TILE, y * TILE, TILE, TILE);
    c.strokeStyle = tile === 2 ? '#c9c0a655' : '#91b48833'; c.lineWidth = 1;
    c.strokeRect(x * TILE + .5, y * TILE + .5, TILE - 1, TILE - 1);
    if (tile === 1) { ellipse(c, x * TILE + 20, y * TILE + 31, 19, 8, '#52684d30'); sprite(c, assets.world, 0, 3, x * TILE + 20, y * TILE + 40, 47); }
    else if (!tile) {
      for (let k = 0; k < 4; k++) { const px = x * TILE + 5 + noise(x + k * 9, y + 3) * 30, py = y * TILE + 7 + noise(x + 2, y + k * 7) * 26;
        c.strokeStyle = '#789c7055'; c.beginPath(); c.moveTo(px - 2, py - 3); c.lineTo(px, py); c.lineTo(px + 2, py - 4); c.stroke(); }
      if (n < .12) sprite(c, assets.world, 2, 3, x * TILE + 20, y * TILE + 34, 28);
    } else { c.fillStyle = '#bdb497'; c.fillRect(x * TILE + n * 29 + 4, y * TILE + 13, 3, 2); }
  }
  // 灌木只在边缘，玩家可活动区的障碍均由 TILES 定义。
  for (let x = 20; x < WORLD_WIDTH; x += 46) { sprite(c, assets.world, 1, 3, x, 24, 53); sprite(c, assets.world, 1, 3, x + 15, WORLD_HEIGHT + 17, 58); }
  for (let y = 65; y < WORLD_HEIGHT - 25; y += 45) { sprite(c, assets.world, 1, 3, 3, y, 50); sprite(c, assets.world, 1, 3, WORLD_WIDTH - 3, y, 50); }
  ellipse(c, 100, 320, 55, 27, '#f2eed87a');
  c.strokeStyle = '#fff9dfaa'; c.lineWidth = 2; c.beginPath(); c.ellipse(100, 320, 55, 27, 0, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#566149'; c.font = '11px sans-serif'; c.textAlign = 'center'; c.fillText('起点', 100, 359);
  return layer;
}

/**
 * 画一帧。
 *
 * `scene` 来自 `Motion.sample()`：位置已经是平滑过的（播放缓冲 + 外推 + 自己的本地前推），
 * 所以这里**不做时间插值**，只负责按场景时钟推进动画与剩余毫秒：
 *   · `now` 是真实时刻，只用来给飘字算年龄（飘字由消息回调按真实时钟打点）；
 *   · `scene.time` 是画面时钟（比 now 慢一个播放缓冲），walk / 受击闪烁 / 挥剑弧线都按它；
 *   · `time - scene.at` 是这帧权威状态已经过去的毫秒数，`attack` / `hurt` 这类
 *     「剩余毫秒」要先扣掉它，否则动画会按收到快照的那一刻从头播。
 * 镜头跟随用的是 scene 里自己的位置 —— 这样镜头与人物的平滑是同一份数据，
 * 不会出现「人物在插值、镜头却按最新快照整格跳」的割裂。
 */
export function render(ctx: CanvasRenderingContext2D, assets: Assets, ground: HTMLCanvasElement, scene: Scene | null, ownId: string, now: number,
  compact: boolean, floating: FloatText[]) {
  const viewW = compact ? 560 : WORLD_WIDTH, viewH = compact ? 420 : WORLD_HEIGHT;
  const time = scene ? scene.time : now;
  const age = scene ? Math.max(0, time - scene.at) : 0;
  const players = scene?.players ?? PREVIEW_PLAYERS;
  const monsters = scene?.slimes ?? PREVIEW_SLIMES;
  const own = players.find(p => p.id === ownId);
  const cx = compact ? Math.max(0, Math.min(WORLD_WIDTH - viewW, (own?.x ?? 100) - viewW / 2)) : 0;
  const cy = compact ? Math.max(0, Math.min(WORLD_HEIGHT - viewH, (own?.y ?? 320) - viewH / 2)) : 0;
  ctx.setTransform(ctx.canvas.width / viewW, 0, 0, ctx.canvas.height / viewH, 0, 0); ctx.clearRect(0, 0, viewW, viewH);
  ctx.save(); ctx.translate(-cx, -cy); ctx.drawImage(ground, 0, 0);
  const entities = [...players.map(p => ({ type: 'player' as const, p, y: p.y })), ...monsters.map(p => ({ type: 'slime' as const, p, y: p.y }))].sort((a, b) => a.y - b.y);
  for (const entity of entities) {
    if (entity.type === 'player') {
      const p = entity.p, x = p.x, y = p.y, mine = p.id === ownId;
      ellipse(ctx, x, y + 1, 15, 6, '#344b3b32');
      if (mine) { ctx.strokeStyle = '#fffbe5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.save();
      const hurt = Math.max(0, p.hurt - age);
      if (hurt > 0) ctx.globalAlpha = Math.floor(time / 70) % 2 ? .45 : 1;
      const attack = Math.max(0, p.attack - age);
      const recoil = hurt > 570;
      const walk = Math.floor(time / 130) % 4;
      const col = recoil ? 3 : p.moving ? [0, 1, 0, 2][walk] : 0;
      // 左右行的第三帧使用反向侧面，翻转同侧步态保持朝向一致。
      if (!attack && !recoil && (p.facing === 1 || p.facing === 2) && col === 2) {
        ctx.translate(x, 0); ctx.scale(-1, 1); sprite(ctx, assets.character, 1, p.facing === 1 ? 2 : 1, 0, y + 4, 88);
      } else sprite(ctx, attack ? assets.attack : assets.character, attack ? Math.min(3, Math.floor((ATTACK_MS - attack) / (ATTACK_MS / 4))) : col, p.facing, x, y + 4, attack ? 96 : 88);
      ctx.restore();
      if (attack > 100 && attack < 280) {
        const dir = DIRECTIONS[p.facing], angle = Math.atan2(dir.y, dir.x);
        ctx.strokeStyle = '#effff4aa'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y - 8, 56, angle - .8, angle + .8); ctx.stroke();
      }
      if (p.name) {
        const label = `${p.name}${mine ? ' · 你' : ''}`;
        ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; const width = Math.min(136, ctx.measureText(label).width + 14);
        ctx.fillStyle = mine ? '#365549e8' : '#46504be0'; ctx.beginPath(); ctx.roundRect(x - width / 2, y - 84, width, 19, 9); ctx.fill();
        ctx.fillStyle = '#fffdf2'; ctx.fillText(label, x, y - 71, width - 10);
      }
    } else {
      const m = entity.p, x = m.x, y = m.y;
      ellipse(ctx, x, y + 1, 16, 6, '#36563b29');
      ctx.save();
      if (m.mood === 'windup') { ctx.strokeStyle = '#b36046'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 27, 0, Math.PI * 2); ctx.stroke(); }
      if (m.mood === 'dying') {
        const phase = Math.max(0, m.phase - age);
        ctx.globalAlpha = Math.min(1, Math.max(0, phase / 400));
        sprite(ctx, assets.world, 3, 3, x, y - (400 - phase) / 25, 42);
        ctx.fillStyle = '#36563b'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`+${[1, 3, 5][m.kind]}`, x, y - 37);
      } else {
        const col = m.mood === 'stunned' ? 3 : m.mood === 'windup' ? 1 : m.mood === 'lunge' ? 2 : [0, 1, 2, 0][Math.floor((time + m.id * 91) / 180) % 4];
        sprite(ctx, assets.world, col, m.kind, x, y + 5, 51);
        if (m.hp < (m.kind === 2 ? 3 : 2)) for (let k = 0; k < m.hp; k++) ellipse(ctx, x - (m.hp - 1) * 3 + k * 6, y - 39, 2, 2, '#4d6350');
      }
      ctx.restore();
    }
  }
  for (const f of floating) {
    const textAge = now - f.at; if (textAge > 1400) continue;
    ctx.globalAlpha = Math.min(1, Math.max(0, 1 - textAge / 1400)); ctx.fillStyle = '#294f39'; ctx.font = 'bold 17px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y - 100 - textAge / 28); ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (compact && own) {
    // 小地图保留全局位置，镜头跟随时仍能找到其他玩家。
    const x = viewW - 107, y = 12;
    ctx.fillStyle = '#294c3bba'; ctx.beginPath(); ctx.roundRect(x, y, 95, 64, 8); ctx.fill();
    for (const p of players) ellipse(ctx, x + p.x / WORLD_WIDTH * 95, y + p.y / WORLD_HEIGHT * 64, p.id === ownId ? 3 : 2, p.id === ownId ? 3 : 2, p.id === ownId ? '#fff5ce' : '#a9e1c5');
  }
}
