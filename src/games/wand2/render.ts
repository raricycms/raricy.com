import { ATTACK_MS, DIRECTIONS, TILE, TILES, TICK_MS, WORLD_HEIGHT, WORLD_WIDTH, type Player, type Slime, type Snapshot } from '../../../shared/wand2/protocol';
import spriteLayout from '../../../public/static/games/wand2/sprite-layout.json';

export interface Assets { character: HTMLImageElement; attack: HTMLImageElement; world: HTMLImageElement }
export interface Frame { previous: Snapshot; current: Snapshot; at: number }
export interface FloatText { x: number; y: number; text: string; at: number }
const palette = ['#b8cfaa', '#b5cca7', '#bdd1b0', '#b9cdaa'];
const noise = (x: number, y: number) => ((x * 73 + y * 137 + x * y * 11) % 101) / 101;

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

export function render(ctx: CanvasRenderingContext2D, assets: Assets, ground: HTMLCanvasElement, frame: Frame | null, ownId: string, now: number,
  compact: boolean, floating: FloatText[]) {
  const viewW = compact ? 560 : WORLD_WIDTH, viewH = compact ? 420 : WORLD_HEIGHT;
  const own = frame?.current.players.find(p => p.id === ownId);
  const cx = compact ? Math.max(0, Math.min(WORLD_WIDTH - viewW, (own?.x ?? 100) - viewW / 2)) : 0;
  const cy = compact ? Math.max(0, Math.min(WORLD_HEIGHT - viewH, (own?.y ?? 320) - viewH / 2)) : 0;
  ctx.setTransform(ctx.canvas.width / viewW, 0, 0, ctx.canvas.height / viewH, 0, 0); ctx.clearRect(0, 0, viewW, viewH);
  ctx.save(); ctx.translate(-cx, -cy); ctx.drawImage(ground, 0, 0);
  // rAF 时间戳可能早于同轮事件循环刚收到的快照，负年龄会把待机算成攻击。
  const frameAge = frame ? Math.max(0, now - frame.at) : 0;
  const progress = frame ? Math.min(1, frameAge / TICK_MS) : 1;
  const players: Player[] = frame?.current.players ?? [{ id: 'preview', name: '', x: 100, y: 320, facing: 0, moving: false, attack: 0, hurt: 0, catnip: 0 }];
  const monsters: Slime[] = frame?.current.slimes ?? [
    { id: 0, x: 340, y: 230, kind: 0, hp: 2, mood: 'wander', phase: 0 },
    { id: 1, x: 440, y: 390, kind: 1, hp: 2, mood: 'wander', phase: 0 },
    { id: 2, x: 690, y: 300, kind: 2, hp: 3, mood: 'wander', phase: 0 },
  ];
  const entities = [...players.map(p => ({ type: 'player' as const, p, y: p.y })), ...monsters.map(p => ({ type: 'slime' as const, p, y: p.y }))].sort((a, b) => a.y - b.y);
  for (const entity of entities) {
    if (entity.type === 'player') {
      const p = entity.p, prev = frame?.previous.players.find(a => a.id === p.id) ?? p;
      const x = prev.x + (p.x - prev.x) * progress, y = prev.y + (p.y - prev.y) * progress, mine = p.id === ownId;
      ellipse(ctx, x, y + 1, 15, 6, '#344b3b32');
      if (mine) { ctx.strokeStyle = '#fffbe5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y, 18, 8, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.save();
      if (p.hurt > 0) ctx.globalAlpha = Math.floor(now / 70) % 2 ? .45 : 1;
      const attack = Math.max(0, p.attack - frameAge);
      const recoil = p.hurt > 570;
      const walk = Math.floor(now / 130) % 4;
      const col = recoil ? 3 : p.moving ? [0, 1, 0, 2][walk] : 0;
      // 各方向直接使用对应原绘帧；镜像会把角色的右手持剑翻成左手。
      sprite(ctx, attack ? assets.attack : assets.character, attack ? Math.min(3, Math.floor((ATTACK_MS - attack) / (ATTACK_MS / 4))) : col, p.facing, x, y + 4, attack ? spriteLayout.attackDrawSize : 88);
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
      const m = entity.p, prev = frame?.previous.slimes.find(a => a.id === m.id) ?? m;
      const x = prev.x + (m.x - prev.x) * progress, y = prev.y + (m.y - prev.y) * progress;
      ellipse(ctx, x, y + 1, 16, 6, '#36563b29');
      ctx.save();
      if (m.mood === 'windup') { ctx.strokeStyle = '#b36046'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 27, 0, Math.PI * 2); ctx.stroke(); }
      if (m.mood === 'dying') {
        ctx.globalAlpha = Math.max(0, m.phase / 400);
        sprite(ctx, assets.world, 3, 3, x, y - (400 - m.phase) / 25, 42);
        ctx.fillStyle = '#36563b'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`+${[1, 3, 5][m.kind]}`, x, y - 37);
      } else {
        const col = m.mood === 'stunned' ? 3 : m.mood === 'windup' ? 1 : m.mood === 'lunge' ? 2 : [0, 1, 2, 0][Math.floor((now + m.id * 91) / 180) % 4];
        sprite(ctx, assets.world, col, m.kind, x, y + 5, 51);
        if (m.hp < (m.kind === 2 ? 3 : 2)) for (let k = 0; k < m.hp; k++) ellipse(ctx, x - (m.hp - 1) * 3 + k * 6, y - 39, 2, 2, '#4d6350');
      }
      ctx.restore();
    }
  }
  for (const f of floating) {
    const age = now - f.at; if (age > 1400) continue;
    ctx.globalAlpha = 1 - age / 1400; ctx.fillStyle = '#294f39'; ctx.font = 'bold 17px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y - 100 - age / 28); ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (compact && own) {
    // 小地图保留全局位置，镜头跟随时仍能找到其他玩家。
    const x = viewW - 107, y = 12;
    ctx.fillStyle = '#294c3bba'; ctx.beginPath(); ctx.roundRect(x, y, 95, 64, 8); ctx.fill();
    for (const p of players) ellipse(ctx, x + p.x / WORLD_WIDTH * 95, y + p.y / WORLD_HEIGHT * 64, p.id === ownId ? 3 : 2, p.id === ownId ? 3 : 2, p.id === ownId ? '#fff5ce' : '#a9e1c5');
  }
}
