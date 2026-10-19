import { ATTACK_COOLDOWN, ATTACK_MS, DIRECTIONS, INPUT, MAX_SLIMES, SPEED, TILE, TILES, WORLD_HEIGHT, WORLD_WIDTH,
  type Facing, type Player, type Slime, type Snapshot } from './protocol.js';

interface Actor extends Player { userId: string; buttons: number; queuedAttack: boolean; cooldown: number; struck: boolean }
interface Monster extends Slime { dx: number; dy: number }
export function blocked(x: number, y: number, radius = 12): boolean {
  if (x < radius || y < radius || x > WORLD_WIDTH - radius || y > WORLD_HEIGHT - radius) return true;
  for (let row = Math.floor((y - radius) / TILE); row <= Math.floor((y + radius) / TILE); row++) {
    for (let col = Math.floor((x - radius) / TILE); col <= Math.floor((x + radius) / TILE); col++) if (TILES[row]?.[col] === 1) return true;
  }
  return false;
}
export function move(p: { x: number; y: number }, dx: number, dy: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
  for (let i = 0; i < steps; i++) {
    if (!blocked(p.x + dx / steps, p.y)) p.x += dx / steps;
    if (!blocked(p.x, p.y + dy / steps)) p.y += dy / steps;
  }
}
function visible(a: { x: number; y: number }, b: { x: number; y: number }, radius = 3) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8);
  for (let i = 1; i <= n; i++) if (blocked(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, radius)) return false;
  return true;
}
// 遇到碎石时沿可通行网格寻找下一步，避免一直顶着障碍追玩家。
function waypoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  if (visible(a, b, 12)) return b;
  const cols = WORLD_WIDTH / TILE, start = Math.floor(a.y / TILE) * cols + Math.floor(a.x / TILE);
  const target = Math.floor(b.y / TILE) * cols + Math.floor(b.x / TILE);
  const queue = [target], parent = new Map<number, number>([[target, target]]);
  for (let i = 0; i < queue.length && !parent.has(start); i++) {
    const k = queue[i], x = k % cols, y = Math.floor(k / cols);
    for (const d of DIRECTIONS) {
      const nx = x + d.x, ny = y + d.y, key = ny * cols + nx;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= WORLD_HEIGHT / TILE || TILES[ny][nx] === 1 || parent.has(key)) continue;
      parent.set(key, k); queue.push(key);
    }
  }
  const next = parent.get(start);
  return next === undefined ? a : { x: (next % cols + .5) * TILE, y: (Math.floor(next / cols) + .5) * TILE };
}

export class Meadow {
  readonly players = new Map<string, Actor>();
  readonly slimes = new Map<number, Monster>();
  private scores = new Map<string, number>();
  private nextSlime = 0;
  private spawnIn = 0;
  private ticks = 0;
  constructor(private random: () => number = Math.random) {}

  join(id: string, userId: string, name: string) {
    // 离线账户最多保留 2048 个，在线账户不被逐出；同账号多标签共享分数。
    if (!this.scores.has(userId) && this.scores.size >= 2048) {
      const online = new Set([...this.players.values()].map(p => p.userId));
      for (const key of this.scores.keys()) if (!online.has(key)) { this.scores.delete(key); break; }
    }
    this.scores.set(userId, this.scores.get(userId) ?? 0);
    this.players.set(id, { id, userId, name: name.slice(0, 32), x: 100, y: 320, facing: 2, moving: false,
      attack: 0, hurt: 0, catnip: this.scores.get(userId)!, buttons: 0, queuedAttack: false, cooldown: 0, struck: false });
    if (this.players.size === 1) { this.spawnIn = 1500; for (let i = 0; i < 6; i++) this.spawn(); }
  }
  leave(id: string) {
    this.players.delete(id);
    if (!this.players.size) { this.slimes.clear(); this.spawnIn = 0; }
  }
  private spawn() {
    if (this.slimes.size >= Math.min(MAX_SLIMES, 9 + this.players.size * 3)) return;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = 48 + this.random() * (WORLD_WIDTH - 96), y = 48 + this.random() * (WORLD_HEIGHT - 96);
      if (blocked(x, y, 20) || Math.hypot(x - 100, y - 320) < 125
        || [...this.players.values()].some(p => Math.hypot(p.x - x, p.y - y) < 100)) continue;
      const roll = this.random(), kind = roll > .94 ? 2 : roll > .72 ? 1 : 0;
      const id = ++this.nextSlime;
      this.slimes.set(id, { id, x, y, kind, hp: kind === 2 ? 3 : 2, mood: 'wander', phase: 500, dx: 0, dy: 0 });
      return;
    }
  }
  step(milliseconds: number) {
    if (!this.players.size) return;
    const ms = Math.max(0, Math.min(milliseconds, 100)), dt = ms / 1000;
    this.ticks++;
    this.spawnIn -= ms;
    if (this.spawnIn <= 0) { this.spawn(); this.spawnIn = 2000 + this.random() * 1500; }
    for (const p of this.players.values()) {
      p.hurt = Math.max(0, p.hurt - ms); p.cooldown = Math.max(0, p.cooldown - ms);
      let dx = Number(!!(p.buttons & INPUT.right)) - Number(!!(p.buttons & INPUT.left));
      let dy = Number(!!(p.buttons & INPUT.down)) - Number(!!(p.buttons & INPUT.up));
      if (!p.attack && (dx || dy)) p.facing = (Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 2 : 1 : dy > 0 ? 0 : 3) as Facing;
      if (((p.buttons & INPUT.attack) || p.queuedAttack) && p.cooldown === 0 && p.hurt < 550) {
        p.attack = ATTACK_MS; p.cooldown = ATTACK_COOLDOWN; p.struck = false;
      }
      p.queuedAttack = false;
      p.moving = !!(dx || dy) && p.hurt < 650;
      if (p.moving) { const norm = Math.hypot(dx, dy); dx /= norm; dy /= norm; move(p, dx * SPEED * dt * (p.attack ? .4 : 1), dy * SPEED * dt * (p.attack ? .4 : 1)); }
      if (p.attack > 0) {
        p.attack = Math.max(0, p.attack - ms);
        if (!p.struck && p.attack <= ATTACK_MS - 100) {
          p.struck = true;
          const facing = DIRECTIONS[p.facing];
          for (const m of this.slimes.values()) {
            const sx = m.x - p.x, sy = m.y - p.y, dist = Math.hypot(sx, sy);
            if (m.mood === 'dying' || dist > 80 || (dist > 20 && (sx * facing.x + sy * facing.y) / dist < .15) || !visible(p, m)) continue;
            m.hp--; m.mood = m.hp <= 0 ? 'dying' : 'stunned'; m.phase = m.hp <= 0 ? 400 : 450;
            move(m, sx / (dist || 1) * 18, sy / (dist || 1) * 18);
            if (m.hp <= 0) this.scores.set(p.userId, (this.scores.get(p.userId) ?? 0) + [1, 3, 5][m.kind]);
          }
        }
      }
    }
    for (const m of this.slimes.values()) {
      m.phase = Math.max(0, m.phase - ms);
      if (m.mood === 'dying') { if (!m.phase) this.slimes.delete(m.id); continue; }
      if (m.mood === 'stunned') { if (!m.phase) m.mood = 'wander'; continue; }
      let nearest: Actor | undefined, distance = 260;
      for (const p of this.players.values()) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < distance) { nearest = p; distance = d; }
      }
      if (m.mood === 'windup') { if (!m.phase) { m.mood = 'lunge'; m.phase = 300; } }
      else if (m.mood === 'lunge') {
        move(m, m.dx * 240 * dt, m.dy * 240 * dt);
        if (!m.phase) { m.mood = 'stunned'; m.phase = 450; }
      } else if (nearest) {
        if (distance < 85 && visible(m, nearest)) {
          m.mood = 'windup'; m.phase = 550;
          m.dx = (nearest.x - m.x) / (distance || 1); m.dy = (nearest.y - m.y) / (distance || 1);
        } else {
          m.mood = 'chase'; const point = waypoint(m, nearest), d = Math.hypot(point.x - m.x, point.y - m.y) || 1;
          move(m, (point.x - m.x) / d * (52 + m.kind * 9) * dt, (point.y - m.y) / d * (52 + m.kind * 9) * dt);
        }
      } else {
        m.mood = 'wander';
        if (!m.phase) { const angle = this.random() * Math.PI * 2; m.dx = Math.cos(angle); m.dy = Math.sin(angle); m.phase = 900 + this.random() * 900; }
        move(m, m.dx * 23 * dt, m.dy * 23 * dt);
      }
      for (const p of this.players.values()) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d > 26 || p.hurt || m.mood === 'stunned') continue;
        p.hurt = 850; p.attack = 0;
        move(p, (p.x - m.x) / (d || 1) * 30, (p.y - m.y) / (d || 1) * 30);
        m.mood = 'stunned'; m.phase = 500;
      }
    }
    for (const p of this.players.values()) p.catnip = this.scores.get(p.userId) ?? 0;
  }
  snapshot(): Snapshot {
    const leaderboard = new Map<string, { id: string; name: string; catnip: number; connections: number }>();
    const players = [...this.players.values()].map(p => {
      const row = leaderboard.get(p.userId);
      if (row) row.connections++; else leaderboard.set(p.userId, { id: p.id, name: p.name, catnip: p.catnip, connections: 1 });
      return { id: p.id, name: p.name, x: round(p.x), y: round(p.y), facing: p.facing, moving: p.moving,
        attack: Math.ceil(p.attack), hurt: Math.ceil(p.hurt), catnip: p.catnip };
    });
    return { type: 'wand2.snapshot', tick: this.ticks, players,
      slimes: [...this.slimes.values()].map(({ dx: _dx, dy: _dy, ...m }) => ({ ...m, x: round(m.x), y: round(m.y), phase: Math.ceil(m.phase) })),
      leaderboard: [...leaderboard.values()].sort((a, b) => b.catnip - a.catnip || a.id.localeCompare(b.id)) };
  }
}
function round(n: number) { return Math.round(n * 100) / 100; }
