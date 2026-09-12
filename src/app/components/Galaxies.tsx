'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 螺旋星系（Galaxies / Tentai Show / Spiral Galaxies）
// 从 Flask 侧 app/static/js/game/galaxies.js（Simon Tatham galaxies.c 的忠实 JS 移植）
// 逐段忠实移植到 React 客户端组件。纯前端逻辑，无服务端依赖。
//
// 玩法要点（与原实现一一对应）：
//   • 把网格划分成若干「星系」区域；每个区域必须围绕其圆点保持 180° 旋转对称，
//     且每个区域恰好含一个圆点。
//   • 左键点击「边」放置 / 移除边界；右键从圆点（或已归属格）拖动来标记格子归属。
//   • 完整移植：谜题生成（generatePass / try_block / 摆动度）、对称求解器
//     （obvious / lines-opposite / one-poss / expand-dots / extend-exclaves / 递归）、
//     完成校验（DSU + 对称检查）、边界与箭头渲染、看答案 / 难度过滤。
//
// 网格坐标系（与 C 一致）：sx=w*2+1, sy=h*2+1。偶偶=顶点(VERTEX)，
// 偶奇/奇偶=边(EDGE)，奇奇=格(TILE)。棋盘用 <canvas> 命令式绘制。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';

// ---- 网格类型与标志位（对齐 galaxies.js）------------------------------------
const T_VERTEX = 0,
  T_EDGE = 1,
  T_TILE = 2;
const F_DOT = 0x01;
const F_EDGE_SET = 0x02;
const F_ASSOC = 0x04;
const F_DOT_BLACK = 0x08;
const F_MARK = 0x10;
const F_REACHABLE = 0x20;
const F_MULTIPLE = 0x80;

const TILE_SIZE = 48;
const DOT_SIZE = TILE_SIZE / 4;
const EDGE_THICKNESS = Math.max(Math.floor(TILE_SIZE / 16), 2);
const BORDER = TILE_SIZE;

// 难度等级（对齐 galaxies.js）
const DIFF_NORMAL = 0;
const DIFF_UNREASONABLE = 1;
const DIFF_IMPOSSIBLE = 2;
const DIFF_AMBIGUOUS = 3;
const DIFF_UNFINISHED = 4;

const GP_DOTS = 1;
const IMPOSSIBLE_QUITS = 1;
const GENERATE_TRIES = 10;
const MAX_GENERATE_ATTEMPTS = 50;
const MAXRECURSE = 5;

// ---- 类型 -------------------------------------------------------------------
type Space = {
  x: number;
  y: number;
  type: number;
  flags: number;
  dotx: number;
  doty: number;
  nassoc: number;
};

type Dsu = { parent: number[]; size: Int32Array };

type Rng = () => number;

type StatusInfo = { completed: boolean; dots: number; size: string };

type Ui = {
  dragging: boolean;
  srcx: number;
  srcy: number;
  dx: number;
  dy: number;
  dotx: number;
  doty: number;
  hoverX: number | null;
  hoverY: number | null;
};

interface SqData {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  valid: boolean;
  cx: number;
  cy: number;
  colour: number;
}

interface SolverCtx {
  sz: number;
  scratch: (Space | null)[];
  dsf: Dsu;
  iscratch: Int32Array;
}

type CheckResult = { complete: boolean; colours: Int32Array };
type EdgeCb = (state: GameState, edge: Space, ctx: SolverCtx) => number;

// ---- 坐标转换（对齐 SCOORD / FROMCOORD / coordRoundToEdge）------------------
function SCOORD(n: number): number {
  return (n * TILE_SIZE) / 2 + BORDER;
}
function FROMCOORD(x: number): number {
  return (x - BORDER) / TILE_SIZE;
}

// 把浮点格坐标就近取整到边（对齐 C 的 coord_round_to_edge）
function coordRoundToEdge(x: number, y: number): { x: number; y: number } {
  const xs = Math.floor(x) + 0.5;
  const ys = Math.floor(y) + 0.5;
  const xv = Math.floor(x + 0.5);
  const yv = Math.floor(y + 0.5);
  const dx = Math.abs(x - xs);
  const dy = Math.abs(y - ys);
  if (dx > dy) {
    return { x: 2 * xv, y: 1 + 2 * Math.floor(ys) };
  } else {
    return { x: 1 + 2 * Math.floor(xs), y: 2 * yv };
  }
}

// ---- Space 创建 -------------------------------------------------------------
function mkSpace(x: number, y: number, type: number): Space {
  return { x, y, type, flags: 0, dotx: -1, doty: -1, nassoc: 0 };
}

// ---- 游戏状态（对齐 GameState）---------------------------------------------
class GameState {
  w: number;
  h: number;
  sx: number;
  sy: number;
  completed: boolean;
  usedSolve: boolean;
  ndots: number;
  dots: Space[];
  grid: Space[];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.sx = w * 2 + 1;
    this.sy = h * 2 + 1;
    this.completed = false;
    this.usedSolve = false;
    this.ndots = 0;
    this.dots = [];

    this.grid = new Array<Space>(this.sx * this.sy);
    for (let x = 0; x < this.sx; x++) {
      for (let y = 0; y < this.sy; y++) {
        let type: number;
        if (x % 2 === 0 && y % 2 === 0) type = T_VERTEX;
        else if (x % 2 === 0 || y % 2 === 0) type = T_EDGE;
        else type = T_TILE;
        const sp = mkSpace(x, y, type);
        this.grid[y * this.sx + x] = sp;
        // 边框边始终置位
        if (
          type === T_EDGE &&
          (x === 0 || y === 0 || x === this.sx - 1 || y === this.sy - 1)
        )
          sp.flags |= F_EDGE_SET;
      }
    }
  }

  sp(x: number, y: number): Space {
    return this.grid[y * this.sx + x];
  }
  inGrid(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.sx && y < this.sy;
  }
  inUI(x: number, y: number): boolean {
    return x > 0 && y > 0 && x < this.sx - 1 && y < this.sy - 1;
  }

  updateDots(): void {
    this.dots = [];
    for (const sp of this.grid) if (sp.flags & F_DOT) this.dots.push(sp);
    this.ndots = this.dots.length;
  }

  clear(clearDots: boolean): void {
    for (let x = 1; x < this.sx - 1; x++)
      for (let y = 1; y < this.sy - 1; y++)
        this.sp(x, y).flags &= clearDots ? 0 : F_DOT | F_DOT_BLACK;
    this.completed = false;
    if (clearDots) this.updateDots();
  }

  dup(): GameState {
    const copy = new GameState(this.w, this.h);
    copy.completed = this.completed;
    for (let i = 0; i < this.grid.length; i++) {
      const s = this.grid[i],
        d = copy.grid[i];
      d.flags = s.flags;
      d.dotx = s.dotx;
      d.doty = s.doty;
      d.nassoc = s.nassoc;
    }
    copy.updateDots();
    return copy;
  }
}

// ---- 并查集 DSU -------------------------------------------------------------
function dsuInit(n: number): Dsu {
  return {
    parent: Array.from({ length: n }, (_, i) => i),
    size: new Int32Array(n).fill(1),
  };
}
function dsuFind(dsu: Dsu, i: number): number {
  while (dsu.parent[i] !== i) {
    dsu.parent[i] = dsu.parent[dsu.parent[i]];
    i = dsu.parent[i];
  }
  return i;
}
function dsuUnion(dsu: Dsu, a: number, b: number): void {
  a = dsuFind(dsu, a);
  b = dsuFind(dsu, b);
  if (a === b) return;
  if (dsu.size[a] < dsu.size[b]) {
    const t = a;
    a = b;
    b = t;
  }
  dsu.parent[b] = a;
  dsu.size[a] += dsu.size[b];
}

// ---- 圆点摆放合法性检查 -----------------------------------------------------
function dotIsPossible(state: GameState, sp: Space, allowAssoc: boolean): boolean {
  let bx = 0,
    by = 0;
  if (sp.type === T_TILE) {
    bx = 1;
    by = 1;
  } else if (sp.type === T_VERTEX) {
    bx = 2;
    by = 2;
  } else if (sp.x % 2 === 0) {
    bx = 2;
    by = 1;
  } else {
    bx = 1;
    by = 2;
  }

  for (let dx = -bx; dx <= bx; dx++)
    for (let dy = -by; dy <= by; dy++) {
      if (!state.inGrid(sp.x + dx, sp.y + dy)) continue;
      const adj = state.sp(sp.x + dx, sp.y + dy);
      if (!allowAssoc && adj.flags & F_ASSOC) return false;
      if (dx !== 0 || dy !== 0) {
        if (adj.flags & F_DOT) return false;
      }
      if (Math.abs(dx) < bx && Math.abs(dy) < by && adj.flags & F_EDGE_SET)
        return false;
    }
  return true;
}

function edgePlacementLegal(state: GameState, x: number, y: number): boolean {
  const sp = state.sp(x, y);
  if (sp.type !== T_EDGE) return false;
  // 检查周围 4 个顶点是否有圆点
  const flags =
    state.sp(x, y).flags |
    state.sp(x & ~1, y & ~1).flags |
    state.sp((x + 1) & ~1, (y + 1) & ~1).flags;
  return !(flags & F_DOT);
}

// ---- 对称辅助 ---------------------------------------------------------------
function tileOpposite(state: GameState, sp: Space): Space | null {
  if (!(sp.flags & F_ASSOC)) return null;
  const ox = 2 * sp.dotx - sp.x;
  const oy = 2 * sp.doty - sp.y;
  if (!state.inGrid(ox, oy)) return null;
  const opp = state.sp(ox, oy);
  return opp.type === T_TILE ? opp : null;
}

function spaceOpposite(state: GameState, sp: Space, dot: Space): Space | null {
  const ox = 2 * dot.x - sp.x,
    oy = 2 * dot.y - sp.y;
  if (!state.inGrid(ox, oy)) return null;
  return state.sp(ox, oy);
}

function okToAddAssocWithOpposite(state: GameState, sp: Space, dot: Space): boolean {
  if (sp.type !== T_TILE) return false;
  if (sp.flags & F_DOT) return false;
  const opp = spaceOpposite(state, sp, dot);
  if (!opp) return false;
  if (opp.flags & F_DOT) return false;
  if (opp.flags & F_ASSOC && (opp.dotx !== dot.x || opp.doty !== dot.y)) return false;
  if (sp.flags & F_ASSOC && sp.dotx === dot.x && sp.doty === dot.y) return false;
  // 检查该格或其对称格是否已属于某个合法区域
  const colours = new Int32Array(state.w * state.h).fill(0);
  checkComplete(state, colours);
  if (colours[((sp.y - 1) >> 1) * state.w + ((sp.x - 1) >> 1)]) return false;
  if (colours[((opp.y - 1) >> 1) * state.w + ((opp.x - 1) >> 1)]) return false;
  return true;
}

function removeAssocWithOpposite(state: GameState, tile: Space): void {
  if (!(tile.flags & F_ASSOC)) return;
  const opp = tileOpposite(state, tile);
  // 移除本格归属
  const dot = state.sp(tile.dotx, tile.doty);
  if (dot) dot.nassoc--;
  tile.flags &= ~F_ASSOC;
  tile.dotx = -1;
  tile.doty = -1;
  // 同时移除对称格归属
  if (opp && opp !== tile) {
    const oppDot = state.sp(opp.dotx, opp.doty);
    if (oppDot) oppDot.nassoc--;
    opp.flags &= ~F_ASSOC;
    opp.dotx = -1;
    opp.doty = -1;
  }
}

function addAssocWithOpposite(state: GameState, tile: Space, dot: Space): void {
  const opp = spaceOpposite(state, tile, dot);
  if (!opp || !okToAddAssocWithOpposite(state, tile, dot)) return;
  removeAssocWithOpposite(state, tile);
  tile.flags |= F_ASSOC;
  tile.dotx = dot.x;
  tile.doty = dot.y;
  dot.nassoc++;
  removeAssocWithOpposite(state, opp);
  opp.flags |= F_ASSOC;
  opp.dotx = dot.x;
  opp.doty = dot.y;
  dot.nassoc++;
}

// ---- 完成校验（对齐 check_complete）----------------------------------------
function checkComplete(state: GameState, outColours?: Int32Array): CheckResult {
  const w = state.w,
    h = state.h;
  const dsu = dsuInit(w * h);

  // 基于边构建连通分量
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // 此格下方是否有边
      if (y + 1 < h && !(state.sp(2 * x + 1, 2 * y + 2).flags & F_EDGE_SET))
        dsuUnion(dsu, y * w + x, (y + 1) * w + x);
      // 此格右方是否有边
      if (x + 1 < w && !(state.sp(2 * x + 2, 2 * y + 1).flags & F_EDGE_SET))
        dsuUnion(dsu, y * w + x, y * w + (x + 1));
    }

  // 每个分量计算包围盒与中心
  const sqdata: SqData[] = [];
  for (let i = 0; i < w * h; i++) {
    sqdata.push({
      minx: w + 1,
      miny: h + 1,
      maxx: -1,
      maxy: -1,
      valid: false,
      cx: -1,
      cy: -1,
      colour: 0,
    });
  }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ci = dsuFind(dsu, y * w + x);
      const sd = sqdata[ci];
      if (sd.minx > x) sd.minx = x;
      if (sd.maxx < x) sd.maxx = x;
      if (sd.miny > y) sd.miny = y;
      if (sd.maxy < y) sd.maxy = y;
      sd.valid = true;
    }

  // 检查每个分量的对称中心处是否有圆点
  for (let i = 0; i < w * h; i++) {
    const sd = sqdata[i];
    if (!sd.valid) continue;
    const cx = (sd.cx = sd.minx + sd.maxx + 1);
    const cy = (sd.cy = sd.miny + sd.maxy + 1);
    // cx, cy 为顶点坐标（均为偶数）
    if (!(state.sp(cx, cy).flags & F_DOT)) sd.valid = false; // 中心无圆点
    // 验证圆点周围 4 格都属于此分量（>>1 对齐 C 的整数除法）
    if (
      dsuFind(dsu, ((cy - 1) >> 1) * w + ((cx - 1) >> 1)) !== i ||
      dsuFind(dsu, ((cy - 1) >> 1) * w + (cx >> 1)) !== i ||
      dsuFind(dsu, (cy >> 1) * w + ((cx - 1) >> 1)) !== i ||
      dsuFind(dsu, (cy >> 1) * w + (cx >> 1)) !== i
    )
      sd.valid = false;
    sd.colour = state.sp(cx, cy).flags & F_DOT_BLACK ? 2 : 1;
  }

  // 检查多余圆点与内部边
  for (let y = 1; y < state.sy - 1; y++)
    for (let x = 1; x < state.sx - 1; x++) {
      const sp = state.sp(x, y);
      if (sp.flags & F_DOT) {
        for (let cy = (y - 1) >> 1; cy <= y >> 1; cy++)
          for (let cx = (x - 1) >> 1; cx <= x >> 1; cx++) {
            const ci = dsuFind(dsu, cy * w + cx);
            if (x !== sqdata[ci].cx || y !== sqdata[ci].cy) sqdata[ci].valid = false;
          }
      }
      if (sp.flags & F_EDGE_SET) {
        const cx1 = (x - 1) >> 1,
          cx2 = x >> 1;
        const cy1 = (y - 1) >> 1,
          cy2 = y >> 1;
        if (cx1 === cx2 || cy1 === cy2) continue; // 跳过顶点
        const a = dsuFind(dsu, cy1 * w + cx1);
        const b = dsuFind(dsu, cy2 * w + cx2);
        if (a === b) sqdata[a].valid = false;
      }
    }

  // 检查每格的旋转对称
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ci = dsuFind(dsu, y * w + x);
      const sd = sqdata[ci];
      if (!sd.valid) continue;
      const x2 = sd.cx - 1 - x;
      const y2 = sd.cy - 1 - y;
      if (dsuFind(dsu, y2 * w + x2) !== ci) sd.valid = false;
    }

  // 汇总结果
  let ret = true;
  const colours = outColours || new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const ci = dsuFind(dsu, i);
    colours[i] = sqdata[ci].valid ? sqdata[ci].colour : 0;
    ret = ret && sqdata[ci].valid;
  }

  return { complete: ret, colours };
}

// ---- 简单归属辅助（生成 / 求解用）------------------------------------------
function addAssoc(state: GameState, tile: Space, dot: Space): void {
  if (tile.flags & F_ASSOC) {
    const oldDot = state.sp(tile.dotx, tile.doty);
    if (oldDot) oldDot.nassoc--;
  }
  tile.flags |= F_ASSOC;
  tile.dotx = dot.x;
  tile.doty = dot.y;
  dot.nassoc++;
}

function removeAssoc(state: GameState, tile: Space): void {
  if (tile.flags & F_ASSOC) {
    state.sp(tile.dotx, tile.doty).nassoc--;
    tile.flags &= ~F_ASSOC;
    tile.dotx = -1;
    tile.doty = -1;
  }
}

// ---- 邻接辅助 ---------------------------------------------------------------
function adjacencies(
  state: GameState,
  sp: Space
): { eadj: (Space | null)[]; tadj: (Space | null)[] } {
  const dxs = [-1, 1, 0, 0],
    dys = [0, 0, -1, 1];
  const eadj = new Array<Space | null>(4),
    tadj = new Array<Space | null>(4);
  for (let n = 0; n < 4; n++) {
    const x = sp.x + dxs[n],
      y = sp.y + dys[n];
    if (state.inGrid(x, y)) {
      eadj[n] = state.sp(x, y);
      const x2 = x + dxs[n],
        y2 = y + dys[n];
      tadj[n] = state.inGrid(x2, y2) ? state.sp(x2, y2) : null;
    } else {
      eadj[n] = tadj[n] = null;
    }
  }
  return { eadj, tadj };
}

// ---- 求解器辅助（生成用）---------------------------------------------------
function solverAddAssoc(state: GameState, tile: Space, dx: number, dy: number): number {
  const dot = state.sp(dx, dy);
  const tileOpp = spaceOpposite(state, tile, dot);
  if (tile.flags & F_ASSOC) {
    if (tile.dotx !== dx || tile.doty !== dy) return -1;
    return 0;
  }
  if (!tileOpp) return -1;
  if (tileOpp.flags & F_ASSOC && (tileOpp.dotx !== dx || tileOpp.doty !== dy)) return -1;
  addAssoc(state, tile, dot);
  addAssoc(state, tileOpp, dot);
  return 1;
}

function solverObviousDot(state: GameState, dot: Space): number {
  let didsth = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!state.inGrid(dot.x + dx, dot.y + dy)) continue;
      const tile = state.sp(dot.x + dx, dot.y + dy);
      if (tile.type === T_TILE) {
        const ret = solverAddAssoc(state, tile, dot.x, dot.y);
        if (ret < 0) return -1;
        if (ret > 0) didsth = 1;
      }
    }
  }
  return didsth;
}

// ---- 描边（在已解区域周围放置边界）----------------------------------------
function outlineTileFordot(state: GameState, tile: Space, mark: boolean): boolean {
  const { eadj, tadj } = adjacencies(state, tile);
  let didsth = false;
  for (let i = 0; i < 4; i++) {
    if (!eadj[i]) continue;
    const edge = !!(eadj[i]!.flags & F_EDGE_SET);
    let same: boolean;
    if (tadj[i]) {
      if (!(tile.flags & F_ASSOC)) same = !(tadj[i]!.flags & F_ASSOC);
      else
        same =
          !!(tadj[i]!.flags & F_ASSOC) &&
          tile.dotx === tadj[i]!.dotx &&
          tile.doty === tadj[i]!.doty;
    } else {
      same = false;
    }
    if (!edge && !same) {
      if (mark) eadj[i]!.flags |= F_EDGE_SET;
      didsth = true;
    } else if (edge && same) {
      if (mark) eadj[i]!.flags &= ~F_EDGE_SET;
      didsth = true;
    }
  }
  return didsth;
}

// ---- dotExpandOrMove --------------------------------------------------------
function dotExpandOrMove(
  state: GameState,
  dot: Space,
  toadd: Space[],
  nadd: number
): boolean {
  // 简单扩张：所有 toadd 格的对称格都必须为空
  for (let i = 0; i < nadd; i++) {
    const tileopp = spaceOpposite(state, toadd[i], dot);
    if (!tileopp) return false;
    if (tileopp.flags & F_ASSOC) return false;
  }
  // 所有对称格都空闲：扩张该区域
  for (let i = 0; i < nadd; i++) {
    const tileopp = spaceOpposite(state, toadd[i], dot)!;
    addAssoc(state, toadd[i], dot);
    addAssoc(state, tileopp, dot);
  }
  return true;
}

// ---- generateTryBlock -------------------------------------------------------
function generateTryBlock(
  state: GameState,
  rng: Rng,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  if (!state.inGrid(x1, y1) || !state.inGrid(x2, y2)) return false;

  const maxsz = Math.floor(Math.sqrt(state.w * state.h)) * 2;
  const toadd: Space[] = [];
  const outside: Space[] = [];

  // 收集块内格子；若已归属则放弃
  for (let x = x1; x <= x2; x += 2) {
    for (let y = y1; y <= y2; y += 2) {
      const sp = state.sp(x, y);
      if (sp.type !== T_TILE) continue;
      if (sp.flags & F_ASSOC) return false;
      toadd.push(sp);
    }
  }
  if (toadd.length === 0) return false;
  const nadd = toadd.length;

  // 收集块外邻接格
  for (let x = x1; x <= x2; x += 2) {
    if (state.inGrid(x, y1 - 2)) outside.push(state.sp(x, y1 - 2));
    if (state.inGrid(x, y2 + 2)) outside.push(state.sp(x, y2 + 2));
  }
  for (let y = y1; y <= y2; y += 2) {
    if (state.inGrid(x1 - 2, y)) outside.push(state.sp(x1 - 2, y));
    if (state.inGrid(x2 + 2, y)) outside.push(state.sp(x2 + 2, y));
  }

  // 洗牌块外格子
  for (let i = outside.length - 1; i > 0; i--) {
    const j = Math.floor((rng() / 0x100000000) * (i + 1));
    [outside[i], outside[j]] = [outside[j], outside[i]];
  }

  for (let i = 0; i < outside.length; i++) {
    if (!(outside[i].flags & F_ASSOC)) continue;
    const dot = state.sp(outside[i].dotx, outside[i].doty);
    if (!(dot.flags & F_DOT)) continue;
    if (dot.nassoc >= maxsz) continue;
    if (dotExpandOrMove(state, dot, toadd, nadd)) return true;
  }
  return false;
}

// ---- generatePass -----------------------------------------------------------
function generatePass(
  state: GameState,
  rng: Rng,
  scratch: Int32Array,
  perc: number,
  flags: number
): void {
  const sz = state.sx * state.sy;

  // 洗牌所有网格位置
  for (let i = 0; i < sz; i++) scratch[i] = i;
  for (let i = sz - 1; i > 0; i--) {
    const j = Math.floor((rng() / 0x100000000) * (i + 1));
    [scratch[i], scratch[j]] = [scratch[j], scratch[i]];
  }

  const nspc = Math.floor((perc * sz) / 100);

  for (let ii = 0; ii < nspc; ii++) {
    const sp = state.grid[scratch[ii]];
    let x1 = sp.x,
      y1 = sp.y,
      x2 = sp.x,
      y2 = sp.y;

    if (sp.type === T_EDGE) {
      if (sp.x % 2 === 0) {
        x1--;
        x2++;
      } else {
        y1--;
        y2++;
      }
    }
    if (sp.type !== T_VERTEX) {
      if (generateTryBlock(state, rng, x1, y1, x2, y2)) continue;
    }

    if (!(flags & GP_DOTS)) continue;

    if (sp.type === T_EDGE && ii % 2) continue;

    if (dotIsPossible(state, sp, false)) {
      sp.flags |= F_DOT;
      sp.nassoc = 0;
      solverObviousDot(state, sp);
    }
  }
}

// ---- 摆动度测量 -------------------------------------------------------------
function isWiggle(
  state: GameState,
  x: number,
  y: number,
  dx: number,
  dy: number
): boolean {
  const x1 = x + 2 * dx,
    y1 = y + 2 * dy;
  const x2 = x - 2 * dy,
    y2 = y + 2 * dx;
  if (!state.inGrid(x1, y1) || !state.inGrid(x2, y2)) return false;
  const t = state.sp(x, y);
  const t1 = state.sp(x1, y1);
  const t2 = state.sp(x2, y2);
  if (!(t.flags & F_ASSOC) || !(t1.flags & F_ASSOC) || !(t2.flags & F_ASSOC))
    return false;
  return (
    t1.dotx === t2.dotx &&
    t1.doty === t2.doty &&
    !(t1.dotx === t.dotx && t1.doty === t.doty)
  );
}

function measureWiggliness(state: GameState): number {
  let nwiggles = 0;
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      if (y + 2 < state.sy) {
        nwiggles += isWiggle(state, x, y, 0, 1) ? 1 : 0;
        nwiggles += isWiggle(state, x, y, 0, -1) ? 1 : 0;
        nwiggles += isWiggle(state, x, y, 1, 0) ? 1 : 0;
        nwiggles += isWiggle(state, x, y, -1, 0) ? 1 : 0;
      }
    }
  }
  return nwiggles;
}

// ---- 谜题生成（对齐 new_game_desc）----------------------------------------
function generatePuzzle(w: number, h: number, diff: number | undefined | null): GameState {
  const sz = (w * 2 + 1) * (h * 2 + 1);
  const scratch = new Int32Array(sz);

  const genStart = Date.now();
  const deadline = genStart + 5000; // 5 秒超时

  for (let genAttempt = 0; genAttempt < MAX_GENERATE_ATTEMPTS; genAttempt++) {
    if (Date.now() > deadline) break;

    // 简单 LCG，对齐 C 的 random_state
    let seed = Math.floor(Math.random() * 0x7fffffff) >>> 0;
    const rng: Rng = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };

    let bestWiggliness = -1;
    let bestState: GameState | null = null;

    for (let attempt = 0; attempt < GENERATE_TRIES; attempt++) {
      const state = new GameState(w, h);

      do {
        state.clear(true);
        generatePass(state, rng, scratch, 100, GP_DOTS);
        state.updateDots();
      } while (state.ndots <= 1);

      const thisWiggliness = measureWiggliness(state);
      if (thisWiggliness > bestWiggliness) {
        bestWiggliness = thisWiggliness;
        bestState = state;
      }
    }

    if (!bestState) continue;

    // 在已解区域周围放置边界
    for (const sp of bestState.grid)
      if (sp.type === T_TILE) outlineTileFordot(bestState, sp, true);

    // 校验解是否完整
    const result = checkComplete(bestState);
    if (!result.complete) continue;

    // 清除边界得到谜题（保留圆点）
    const puzzleState = bestState.dup();
    puzzleState.clear(false);
    puzzleState.updateDots();

    // 难度过滤：在副本上跑求解器，避免破坏谜题
    if (diff !== undefined && diff !== null) {
      const checkState = puzzleState.dup();
      const puzzleDiff = solverState(checkState, diff);
      if (puzzleDiff !== diff) continue;
    }

    return puzzleState;
  }

  // 兜底：返回一个不做难度过滤的谜题
  const fallback = new GameState(w, h);
  let seed = Math.floor(Math.random() * 0x7fffffff) >>> 0;
  const rng: Rng = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  };
  do {
    fallback.clear(true);
    generatePass(fallback, rng, scratch, 100, GP_DOTS);
    fallback.updateDots();
  } while (fallback.ndots <= 1);
  for (const sp of fallback.grid)
    if (sp.type === T_TILE) outlineTileFordot(fallback, sp, true);
  fallback.clear(false);
  fallback.updateDots();
  return fallback;
}

// ---- 求解器（移植自 galaxies.c）--------------------------------------------
// 相对某个圆点的对称格（spaceOpposite 的一般形式）
function solverOpposite(state: GameState, sp: Space, dot: Space): Space | null {
  const dx = sp.x - dot.x;
  const dy = sp.y - dot.y;
  const tx = dot.x - dx;
  const ty = dot.y - dy;
  if (!state.inGrid(tx, ty)) return null;
  return state.sp(tx, ty);
}

function dotfortile(state: GameState, tile: Space, dot: Space): boolean {
  const tileOpp = solverOpposite(state, tile, dot);
  if (!tileOpp) return false;
  if (tileOpp.flags & F_ASSOC && (tileOpp.dotx !== dot.x || tileOpp.doty !== dot.y))
    return false;
  return true;
}

function tilesFromEdge(state: GameState, edge: Space, out: (Space | null)[]): void {
  if (edge.x % 2 === 0) {
    out[0] = state.inGrid(edge.x - 1, edge.y) ? state.sp(edge.x - 1, edge.y) : null;
    out[1] = state.inGrid(edge.x + 1, edge.y) ? state.sp(edge.x + 1, edge.y) : null;
  } else {
    out[0] = state.inGrid(edge.x, edge.y - 1) ? state.sp(edge.x, edge.y - 1) : null;
    out[1] = state.inGrid(edge.x, edge.y + 1) ? state.sp(edge.x, edge.y + 1) : null;
  }
}

// ---- 求解器迭代器 -----------------------------------------------------------
function foreachTileSol<C>(
  state: GameState,
  cb: (s: GameState, sp: Space, ctx: C) => number,
  f: number,
  ctx: C
): number {
  let progress = false,
    impossible = false;
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      const ret = cb(state, state.sp(x, y), ctx);
      if (ret === -1) {
        if (f & IMPOSSIBLE_QUITS) return -1;
        impossible = true;
      } else if (ret === 1) {
        progress = true;
      }
    }
  }
  return impossible ? -1 : progress ? 1 : 0;
}

function foreachEdgeSol(state: GameState, cb: EdgeCb, f: number, ctx: SolverCtx): number {
  let progress = false,
    impossible = false;
  // 竖边：x 偶，y 奇
  for (let y = 1; y < state.sy; y += 2)
    for (let x = 0; x < state.sx; x += 2) {
      const ret = cb(state, state.sp(x, y), ctx);
      if (ret === -1) {
        if (f & IMPOSSIBLE_QUITS) return -1;
        impossible = true;
      } else if (ret === 1) {
        progress = true;
      }
    }
  // 横边：x 奇，y 偶
  for (let y = 0; y < state.sy; y += 2)
    for (let x = 1; x < state.sx; x += 2) {
      const ret = cb(state, state.sp(x, y), ctx);
      if (ret === -1) {
        if (f & IMPOSSIBLE_QUITS) return -1;
        impossible = true;
      } else if (ret === 1) {
        progress = true;
      }
    }
  return impossible ? -1 : progress ? 1 : 0;
}

// ---- 求解技巧 0：与圆点显然相邻 -------------------------------------------
function solverObviousAll(state: GameState): number {
  let didsth = 0;
  for (let i = 0; i < state.ndots; i++) {
    const ret = solverObviousDot(state, state.dots[i]);
    if (ret < 0) return -1;
    if (ret > 0) didsth = 1;
  }
  return didsth;
}

// ---- 求解技巧 1：对侧连线 ---------------------------------------------------
function solverLinesOppositeCb(state: GameState, edge: Space): number {
  let didsth = 0;
  const tiles: (Space | null)[] = [null, null];
  tilesFromEdge(state, edge, tiles);

  // 若两侧格归属于不同圆点，则此边置位
  if (
    !(edge.flags & F_EDGE_SET) &&
    tiles[0] &&
    tiles[1] &&
    tiles[0].flags & F_ASSOC &&
    tiles[1].flags & F_ASSOC &&
    (tiles[0].dotx !== tiles[1].dotx || tiles[0].doty !== tiles[1].doty)
  ) {
    edge.flags |= F_EDGE_SET;
    didsth = 1;
  }

  if (!(edge.flags & F_EDGE_SET)) return didsth;

  // 把边转移到每个相邻格的对侧
  for (let n = 0; n < 2; n++) {
    const tn = tiles[n];
    if (!tn) continue;
    if (!(tn.flags & F_ASSOC)) continue;

    const tileOpp = tileOpposite(state, tn);
    if (!tileOpp) return -1;

    const dx = tn.x - edge.x;
    const dy = tn.y - edge.y;
    const edgeOpp = state.sp(tileOpp.x + dx, tileOpp.y + dy);
    if (!(edgeOpp.flags & F_EDGE_SET)) {
      edgeOpp.flags |= F_EDGE_SET;
      didsth = 1;
    }
  }
  return didsth;
}

// ---- 求解技巧 2：依据周围边推出唯一可能圆点 -------------------------------
function solverSpacesOnepossCb(state: GameState, tile: Space): number {
  if (tile.flags & F_ASSOC) return 0;

  const { eadj, tadj } = adjacencies(state, tile);

  let eset = 0,
    dotx = -1,
    doty = -1;
  for (let n = 0; n < 4; n++) {
    if (eadj[n]!.flags & F_EDGE_SET) {
      eset++;
    } else {
      if (!tadj[n]) return 0;
      if (!(tadj[n]!.flags & F_ASSOC)) return 0;
      if (dotx !== -1 && doty !== -1 && (tadj[n]!.dotx !== dotx || tadj[n]!.doty !== doty))
        return 0;
      dotx = tadj[n]!.dotx;
      doty = tadj[n]!.doty;
    }
  }
  if (eset === 4) return -1; // 被完全包围且无出口

  const ret = solverAddAssoc(state, tile, dotx, doty);
  if (ret === -1) return -1;
  return 1;
}

// ---- 求解技巧 3：从圆点做视线扩张 ------------------------------------------
function solverExpandCheckdot(tile: Space, dot: Space): boolean {
  if (!(tile.flags & F_ASSOC)) return true;
  return tile.dotx === dot.x && tile.doty === dot.y;
}

function solverExpandFromdot(state: GameState, dot: Space, sctx: SolverCtx): void {
  // 清除所有格的 F_MARK
  for (let y = 1; y < state.sy; y += 2)
    for (let x = 1; x < state.sx; x += 2) state.sp(x, y).flags &= ~F_MARK;

  // 用与此圆点关联的两个格做种子
  if (dot.type === T_TILE) {
    sctx.scratch[0] = dot;
    sctx.scratch[1] = dot;
  } else if (dot.type === T_EDGE) {
    tilesFromEdge(state, dot, sctx.scratch);
  } else {
    sctx.scratch[0] = state.sp(dot.x - 1, dot.y - 1);
    sctx.scratch[1] = state.sp(dot.x + 1, dot.y + 1);
  }

  sctx.scratch[0]!.flags |= F_MARK;
  sctx.scratch[1]!.flags |= F_MARK;

  let start = 0,
    end = 2,
    next = 2;

  while (true) {
    for (let i = start; i < end; i += 2) {
      const t1 = sctx.scratch[i]!;
      const { eadj, tadj } = adjacencies(state, t1);

      for (let j = 0; j < 4; j++) {
        if (eadj[j]!.flags & F_EDGE_SET) continue;

        const tileadj = tadj[j]!;
        if (tileadj.flags & F_MARK) continue;

        const tileadj2 = solverOpposite(state, tileadj, dot);
        if (!tileadj2) {
          tileadj.flags |= F_MARK;
          continue;
        }

        if (solverExpandCheckdot(tileadj, dot) && solverExpandCheckdot(tileadj2, dot)) {
          sctx.scratch[next++] = tileadj;
          sctx.scratch[next++] = tileadj2;
        }

        tileadj.flags |= F_MARK;
        tileadj2.flags |= F_MARK;
      }
    }

    if (next > end) {
      start = end;
      end = next;
    } else {
      break;
    }
  }

  // 更新空格的 F_REACHABLE / F_MULTIPLE 标志
  for (let i = 0; i < end; i++) {
    const s = sctx.scratch[i]!;
    if (s.flags & F_ASSOC) continue;
    if (s.flags & F_REACHABLE) {
      s.flags |= F_MULTIPLE;
    } else {
      s.flags |= F_REACHABLE;
      s.dotx = dot.x;
      s.doty = dot.y;
    }
  }
}

function solverExpandPostcb(state: GameState, tile: Space): number {
  if (tile.flags & F_ASSOC) return 0;
  if (!(tile.flags & F_REACHABLE)) return -1;
  if (tile.flags & F_MULTIPLE) return 0;
  return solverAddAssoc(state, tile, tile.dotx, tile.doty);
}

function solverExpandDots(state: GameState, sctx: SolverCtx): number {
  for (let i = 0; i < sctx.sz; i++) state.grid[i].flags &= ~(F_REACHABLE | F_MULTIPLE);

  for (let i = 0; i < state.ndots; i++) solverExpandFromdot(state, state.dots[i], sctx);

  return foreachTileSol(state, solverExpandPostcb, IMPOSSIBLE_QUITS, sctx);
}

// ---- 求解技巧 4：延伸飞地（exclaves）---------------------------------------
function solverExtendExclaves(state: GameState, sctx: SolverCtx): number {
  let done_something = 0;

  // 重置 DSU
  const dsu = sctx.dsf;
  for (let i = 0; i < sctx.sz; i++) {
    dsu.parent[i] = i;
    dsu.size[i] = 1;
  }

  // 合并归属同一圆点的相邻格
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      const tile = state.sp(x, y);
      if (!(tile.flags & F_ASSOC)) continue;
      const dotx = tile.dotx,
        doty = tile.doty;

      if (state.inGrid(x + 2, y)) {
        const other = state.sp(x + 2, y);
        if (other.flags & F_ASSOC && other.dotx === dotx && other.doty === doty)
          dsuUnion(dsu, y * state.sx + x, y * state.sx + (x + 2));
      }

      if (state.inGrid(x, y + 2)) {
        const other = state.sp(x, y + 2);
        if (other.flags & F_ASSOC && other.dotx === dotx && other.doty === doty)
          dsuUnion(dsu, y * state.sx + x, (y + 2) * state.sx + x);
      }
    }
  }

  // 初始化 iscratch：非代表元 -1，代表元置 0（气数）
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      const index = y * state.sx + x;
      const tile = state.sp(x, y);
      if (!(tile.flags & F_ASSOC) || dsuFind(dsu, index) !== index) {
        sctx.iscratch[index] = -1;
      } else {
        sctx.iscratch[index] = 0;
        sctx.iscratch[index - 1] = 0;
      }
    }
  }

  // 为每个分量统计气（未归属的相邻格）
  const dirs = [
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 2],
  ];
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      if (state.sp(x, y).flags & F_ASSOC) continue;

      const ni: number[] = [];
      let nn = 0;
      for (const [ddx, ddy] of dirs) {
        const nx = x + ddx,
          ny = y + ddy;
        if (!state.inGrid(nx, ny)) continue;
        if (!(state.sp(nx, ny).flags & F_ASSOC)) continue;

        let nindex = ny * state.sx + nx;
        nindex = dsuFind(dsu, nindex);

        let seen = false;
        for (let i = 0; i < nn; i++) if (ni[i] === nindex) { seen = true; break; }
        if (!seen) {
          sctx.iscratch[nindex]++;
          sctx.iscratch[nindex - 1] = y * state.sx + x;
          ni[nn++] = nindex;
        }
      }
    }
  }

  // 延伸只剩一口气的飞地
  for (let y = 1; y < state.sy; y += 2) {
    for (let x = 1; x < state.sx; x += 2) {
      const index = y * state.sx + x;
      if (sctx.iscratch[index] === -1) continue;

      const tile = state.sp(x, y);
      if (!(tile.flags & F_ASSOC)) continue;
      const dotx = tile.dotx,
        doty = tile.doty;

      // 检查此分量是否包含自身的圆点
      const dotCanonIdx = (doty | 1) * state.sx + (dotx | 1);
      if (index === dsuFind(dsu, dotCanonIdx)) continue; // 不是飞地

      if (sctx.iscratch[index] === 0) return -1; // 无气 = 不可能
      if (sctx.iscratch[index] !== 1) continue; // 有歧义

      const libertyIdx = sctx.iscratch[index - 1];
      const ex = libertyIdx % state.sx;
      const ey = Math.floor(libertyIdx / state.sx);
      const libertyTile = state.sp(ex, ey);
      if (libertyTile.flags & F_ASSOC) continue;

      const added = solverAddAssoc(state, libertyTile, dotx, doty);
      if (added < 0) return -1;
      if (added > 0) done_something = 1;
    }
  }

  return done_something;
}

// ---- 递归求解器（Unreasonable 难度）---------------------------------------
type RecurseCtx = { best: Space | null; bestn: number };

function solverRecurseCb(state: GameState, tile: Space, ctx: RecurseCtx): number {
  if (tile.flags & F_ASSOC) return 0;
  let n = 0;
  for (let i = 0; i < state.ndots; i++)
    if (dotfortile(state, tile, state.dots[i])) n++;
  if (n > ctx.bestn) {
    ctx.bestn = n;
    ctx.best = tile;
  }
  return 0;
}

type RecurseSnapshot = {
  grid: { flags: number; dotx: number; doty: number; nassoc: number }[];
  dotsDotx: number[];
  dotsDoty: number[];
  dotsNassoc: number[];
};

function solverRecurse(state: GameState, maxdiff: number, depth: number): number {
  if (depth >= MAXRECURSE) return DIFF_UNFINISHED;

  const rctx: RecurseCtx = { best: null, bestn: 0 };
  foreachTileSol(state, solverRecurseCb, 0, rctx);
  if (rctx.bestn === 0) return DIFF_IMPOSSIBLE;

  const gsz = state.sx * state.sy;

  const snapshot = (): RecurseSnapshot => {
    const arr = new Array<{ flags: number; dotx: number; doty: number; nassoc: number }>(gsz);
    for (let i = 0; i < gsz; i++) {
      const s = state.grid[i];
      arr[i] = { flags: s.flags, dotx: s.dotx, doty: s.doty, nassoc: s.nassoc };
    }
    const dotsDotx = new Array<number>(state.ndots);
    const dotsDoty = new Array<number>(state.ndots);
    const dotsNassoc = new Array<number>(state.ndots);
    for (let i = 0; i < state.ndots; i++) {
      dotsDotx[i] = state.dots[i].dotx;
      dotsDoty[i] = state.dots[i].doty;
      dotsNassoc[i] = state.dots[i].nassoc;
    }
    return { grid: arr, dotsDotx, dotsDoty, dotsNassoc };
  };

  const restore = (snap: RecurseSnapshot): void => {
    for (let i = 0; i < gsz; i++) {
      state.grid[i].flags = snap.grid[i].flags;
      state.grid[i].dotx = snap.grid[i].dotx;
      state.grid[i].doty = snap.grid[i].doty;
      state.grid[i].nassoc = snap.grid[i].nassoc;
    }
    state.updateDots();
    for (let i = 0; i < state.ndots; i++) {
      state.dots[i].dotx = snap.dotsDotx[i];
      state.dots[i].doty = snap.dotsDoty[i];
      state.dots[i].nassoc = snap.dotsNassoc[i];
    }
  };

  const ingrid = snapshot();
  let diff = DIFF_IMPOSSIBLE;
  let outgrid: RecurseSnapshot | null = null;

  for (let n = 0; n < state.ndots; n++) {
    restore(ingrid);

    if (!dotfortile(state, rctx.best!, state.dots[n])) continue;

    solverAddAssoc(state, rctx.best!, state.dots[n].x, state.dots[n].y);

    const ret = solverStateInner(state, maxdiff, depth + 1);

    if (diff === DIFF_IMPOSSIBLE && ret !== DIFF_IMPOSSIBLE) outgrid = snapshot();

    if (ret === DIFF_AMBIGUOUS || ret === DIFF_UNFINISHED) diff = ret;
    else if (ret === DIFF_IMPOSSIBLE) {
      /* leave diff unchanged */
    } else if (diff === DIFF_IMPOSSIBLE) diff = DIFF_UNREASONABLE;
    else diff = DIFF_AMBIGUOUS;

    if (diff === DIFF_AMBIGUOUS || diff === DIFF_UNFINISHED) break;
  }

  if (outgrid) restore(outgrid);
  return diff;
}

// ---- 求解器上下文 -----------------------------------------------------------
function newSolverContext(state: GameState): SolverCtx {
  const sz = state.sx * state.sy;
  return {
    sz,
    scratch: new Array<Space | null>(sz),
    dsf: dsuInit(sz),
    iscratch: new Int32Array(sz),
  };
}

// ---- 主求解入口 -------------------------------------------------------------
function solverStateInner(state: GameState, maxdiff: number, depth: number): number {
  const sctx = newSolverContext(state);
  let diff = DIFF_NORMAL;
  let ret: number;

  ret = solverObviousAll(state);
  if (ret < 0) return DIFF_IMPOSSIBLE;

  while (true) {
    ret = foreachEdgeSol(state, solverLinesOppositeCb, IMPOSSIBLE_QUITS, sctx);
    if (ret < 0) return DIFF_IMPOSSIBLE;
    if (ret > 0) {
      diff = Math.max(diff, DIFF_NORMAL);
      continue;
    }

    ret = foreachTileSol(state, solverSpacesOnepossCb, IMPOSSIBLE_QUITS, sctx);
    if (ret < 0) return DIFF_IMPOSSIBLE;
    if (ret > 0) {
      diff = Math.max(diff, DIFF_NORMAL);
      continue;
    }

    ret = solverExpandDots(state, sctx);
    if (ret < 0) return DIFF_IMPOSSIBLE;
    if (ret > 0) {
      diff = Math.max(diff, DIFF_NORMAL);
      continue;
    }

    ret = solverExtendExclaves(state, sctx);
    if (ret < 0) return DIFF_IMPOSSIBLE;
    if (ret > 0) {
      diff = Math.max(diff, DIFF_NORMAL);
      continue;
    }

    break;
  }

  if (checkComplete(state).complete) return diff;

  diff = maxdiff >= DIFF_UNREASONABLE ? solverRecurse(state, maxdiff, depth) : DIFF_UNFINISHED;

  return diff;
}

function solverState(state: GameState, maxdiff: number): number {
  return solverStateInner(state, maxdiff, 0);
}

// ---- 渲染器（对齐 galaxies.js 的 Renderer）---------------------------------
class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  state: GameState;

  constructor(canvas: HTMLCanvasElement, state: GameState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;
    this._computeSize();
  }

  _computeSize(): void {
    const s = this.state;
    this.canvas.width = BORDER * 2 + s.w * TILE_SIZE;
    this.canvas.height = BORDER * 2 + s.h * TILE_SIZE;
  }

  draw(dark: boolean, ui: Ui | null, colours: Int32Array | null): void {
    const ctx = this.ctx;
    const state = this.state;
    const w = state.w,
      h = state.h;

    const tileBg = dark ? '#313244' : '#f0f0f0';
    const gridCol = dark ? '#585b70' : '#d0d0d0';
    const edgeCol = dark ? '#cdd6f4' : '#11111b';
    const dotCol = dark ? '#f9e2af' : '#df8e1d';
    const dotInner = dark ? '#1e1e2e' : '#ffffff';
    const arrowCol = dark ? '#89b4fa' : '#1e66f5';
    const doneBg = dark ? 'rgba(166,227,161,0.15)' : 'rgba(64,160,43,0.12)';
    const whiteBg = dark ? '#45475a' : '#e8e8e8';
    const blackBg = dark ? '#181825' : '#333333';

    // 外框
    ctx.fillStyle = edgeCol;
    ctx.fillRect(
      BORDER - TILE_SIZE + EDGE_THICKNESS,
      BORDER - TILE_SIZE + EDGE_THICKNESS,
      w * TILE_SIZE + BORDER * 2 - EDGE_THICKNESS * 2,
      h * TILE_SIZE + BORDER * 2 - EDGE_THICKNESS * 2
    );

    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const lx = BORDER + x * TILE_SIZE;
        const ly = BORDER + y * TILE_SIZE;

        // 格背景
        const ci = colours ? colours[y * w + x] : 0;
        if (ci === 1) ctx.fillStyle = whiteBg;
        else if (ci === 2) ctx.fillStyle = blackBg;
        else ctx.fillStyle = state.completed ? doneBg : tileBg;
        ctx.fillRect(lx, ly, TILE_SIZE, TILE_SIZE);

        // 网格线
        ctx.fillStyle = ci === 2 ? dotCol : gridCol;
        ctx.fillRect(lx, ly, 1, TILE_SIZE);
        ctx.fillRect(lx, ly, TILE_SIZE, 1);

        // 四边：L, R, U, D
        ctx.fillStyle = edgeCol;
        const edgeL = state.sp(x * 2, y * 2 + 1);
        const edgeR = state.sp(x * 2 + 2, y * 2 + 1);
        const edgeU = state.sp(x * 2 + 1, y * 2);
        const edgeD = state.sp(x * 2 + 1, y * 2 + 2);

        if (edgeL.flags & F_EDGE_SET) ctx.fillRect(lx, ly, EDGE_THICKNESS, TILE_SIZE);
        if (edgeR.flags & F_EDGE_SET)
          ctx.fillRect(lx + TILE_SIZE - EDGE_THICKNESS + 1, ly, EDGE_THICKNESS - 1, TILE_SIZE);
        if (edgeU.flags & F_EDGE_SET) ctx.fillRect(lx, ly, TILE_SIZE, EDGE_THICKNESS);
        if (edgeD.flags & F_EDGE_SET)
          ctx.fillRect(lx, ly + TILE_SIZE - EDGE_THICKNESS + 1, TILE_SIZE, EDGE_THICKNESS - 1);

        // 角标
        const hasUL =
          (x > 0 && state.sp(x * 2 - 1, y * 2).flags & F_EDGE_SET) ||
          (y > 0 && state.sp(x * 2, y * 2 - 1).flags & F_EDGE_SET);
        const hasUR =
          (x + 1 < w && state.sp(x * 2 + 3, y * 2).flags & F_EDGE_SET) ||
          (y > 0 && state.sp(x * 2 + 2, y * 2 - 1).flags & F_EDGE_SET);
        const hasDL =
          (x > 0 && state.sp(x * 2 - 1, y * 2 + 2).flags & F_EDGE_SET) ||
          (y + 1 < h && state.sp(x * 2, y * 2 + 3).flags & F_EDGE_SET);
        const hasDR =
          (x + 1 < w && state.sp(x * 2 + 3, y * 2 + 2).flags & F_EDGE_SET) ||
          (y + 1 < h && state.sp(x * 2 + 2, y * 2 + 3).flags & F_EDGE_SET);

        if (hasUL) ctx.fillRect(lx, ly, EDGE_THICKNESS, EDGE_THICKNESS);
        if (hasUR)
          ctx.fillRect(lx + TILE_SIZE - EDGE_THICKNESS + 1, ly, EDGE_THICKNESS - 1, EDGE_THICKNESS);
        if (hasDL)
          ctx.fillRect(lx, ly + TILE_SIZE - EDGE_THICKNESS + 1, EDGE_THICKNESS, EDGE_THICKNESS - 1);
        if (hasDR)
          ctx.fillRect(
            lx + TILE_SIZE - EDGE_THICKNESS + 1,
            ly + TILE_SIZE - EDGE_THICKNESS + 1,
            EDGE_THICKNESS - 1,
            EDGE_THICKNESS - 1
          );

        // 从格指向所属圆点的箭头
        const tile = state.sp(x * 2 + 1, y * 2 + 1);
        if (tile.flags & F_ASSOC) {
          const tcx = lx + TILE_SIZE / 2,
            tcy = ly + TILE_SIZE / 2;
          const dx = SCOORD(tile.dotx),
            dy = SCOORD(tile.doty);
          const ddx = dx - tcx,
            ddy = dy - tcy;
          const sqdist = ddx * ddx + ddy * ddy;
          if (sqdist > 0) {
            const vlen = Math.sqrt(sqdist);
            const xdx = ddx / vlen,
              xdy = ddy / vlen;
            const ydx = -xdy,
              ydy = xdx;
            const e1x = tcx + (xdx * TILE_SIZE) / 3,
              e1y = tcy + (xdy * TILE_SIZE) / 3;
            const e2x = tcx - (xdx * TILE_SIZE) / 3,
              e2y = tcy - (xdy * TILE_SIZE) / 3;
            const ad1x = ((ydx - xdx) * TILE_SIZE) / 8,
              ad1y = ((ydy - xdy) * TILE_SIZE) / 8;
            const ad2x = ((-ydx - xdx) * TILE_SIZE) / 8,
              ad2y = ((-ydy - xdy) * TILE_SIZE) / 8;

            ctx.strokeStyle = arrowCol;
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(e1x, e1y);
            ctx.lineTo(e2x, e2y);
            ctx.moveTo(e1x, e1y);
            ctx.lineTo(e1x + ad1x, e1y + ad1y);
            ctx.moveTo(e1x, e1y);
            ctx.lineTo(e1x + ad2x, e1y + ad2y);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

    // 顶点处的圆点
    for (const dot of state.dots) {
      const dx = SCOORD(dot.x),
        dy = SCOORD(dot.y);
      const isBlack = !!(dot.flags & F_DOT_BLACK);
      ctx.beginPath();
      ctx.arc(dx, dy, DOT_SIZE, 0, Math.PI * 2);
      ctx.fillStyle = isBlack ? dotCol : dotInner;
      ctx.fill();
      ctx.strokeStyle = dotCol;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (!isBlack) {
        ctx.beginPath();
        ctx.arc(dx, dy, DOT_SIZE * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = dotCol;
        ctx.fill();
      }
    }

    // 拖拽箭头
    if (ui && ui.dragging) {
      const sx = SCOORD(ui.srcx),
        sy = SCOORD(ui.srcy);
      ctx.save();
      ctx.strokeStyle = arrowCol;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ui.dx, ui.dy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 悬停边提示
    if (ui && ui.hoverX !== null && ui.hoverY !== null) {
      const hx = ui.hoverX,
        hy = ui.hoverY;
      const sp = state.sp(hx, hy);
      if (sp.type === T_EDGE && !(sp.flags & F_EDGE_SET)) {
        ctx.save();
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)';
        if (hx % 2 === 0) {
          ctx.fillRect(SCOORD(hx), SCOORD(hy - 1), EDGE_THICKNESS, TILE_SIZE);
        } else {
          ctx.fillRect(SCOORD(hx - 1), SCOORD(hy), TILE_SIZE, EDGE_THICKNESS);
        }
        ctx.restore();
      }
    }
  }
}

// ---- 控制器（对齐 galaxies.js 的 GalaxiesGame）----------------------------
interface GalaxiesOpts {
  w?: number;
  h?: number;
  diff?: number;
  darkMode?: boolean;
  onStatus?: (s: StatusInfo) => void;
}

class GalaxiesController {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  diff: number | undefined;
  dark: boolean;
  onStatus: (s: StatusInfo) => void;
  state: GameState;
  renderer: Renderer;
  colours: Int32Array | null;
  ui: Ui;
  _flashTime: number;
  private _handlers: Array<[keyof HTMLElementEventMap, EventListener]> = [];

  constructor(canvas: HTMLCanvasElement, opts: GalaxiesOpts = {}) {
    this.canvas = canvas;
    this.w = opts.w || 7;
    this.h = opts.h || 7;
    this.diff = opts.diff;
    this.dark = opts.darkMode || false;
    this.onStatus = opts.onStatus || (() => {});

    this.state = generatePuzzle(this.w, this.h, this.diff);

    this.renderer = new Renderer(canvas, this.state);
    this.colours = null;

    this.ui = {
      dragging: false,
      srcx: 0,
      srcy: 0,
      dx: 0,
      dy: 0,
      dotx: -1,
      doty: -1,
      hoverX: null,
      hoverY: null,
    };
    this._flashTime = 0;

    this._updateColours();
    this._draw();
    this._emitStatus();
    this._bindEvents();
  }

  _updateColours(): void {
    const result = checkComplete(this.state);
    this.colours = result.colours;
    if (result.complete && !this.state.completed) {
      this.state.completed = true;
      this._flashTime = 3;
      this._flashLoop();
    } else if (!result.complete && this.state.completed) {
      this.state.completed = false;
      this._flashTime = 0;
    }
  }

  _flashLoop(): void {
    if (this._flashTime <= 0) return;
    this._draw();
    this._flashTime--;
    if (this._flashTime > 0) {
      requestAnimationFrame(() => this._flashLoop());
    } else {
      this._draw();
    }
  }

  _draw(): void {
    this.renderer.draw(this.dark, this.ui, this.colours);
    if (this._flashTime > 0 && this._flashTime % 2 === 0) {
      const ctx = this.renderer.ctx;
      ctx.save();
      ctx.fillStyle = this.dark ? 'rgba(166,227,161,0.2)' : 'rgba(64,160,43,0.15)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }
  }

  _emitStatus(): void {
    this.onStatus({
      completed: this.state.completed,
      dots: this.state.ndots,
      size: `${this.state.w}x${this.state.h}`,
    });
  }

  _canvasXY(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  private _on<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void
  ): void {
    const listener = handler as EventListener;
    this.canvas.addEventListener(type, listener);
    this._handlers.push([type, listener]);
  }

  destroy(): void {
    for (const [type, listener] of this._handlers)
      this.canvas.removeEventListener(type, listener);
    this._handlers = [];
  }

  _bindEvents(): void {
    // 左键：切换边（对齐 C 的 coord_round_to_edge）
    this._on('click', (e) => {
      const { x: mx, y: my } = this._canvasXY(e);
      const coords = coordRoundToEdge(FROMCOORD(mx), FROMCOORD(my));
      const gx = coords.x,
        gy = coords.y;
      if (!this.state.inUI(gx, gy)) return;
      const sp = this.state.sp(gx, gy);
      if (sp.type !== T_EDGE) return;
      if (!edgePlacementLegal(this.state, gx, gy)) return;
      sp.flags ^= F_EDGE_SET;
      this._updateColours();
      this._draw();
      this._emitStatus();
    });

    // 右键 / 拖拽：把格归属到圆点（对齐 C 的 interpret_move）
    this._on('contextmenu', (e) => {
      e.preventDefault();
      const { x: mx, y: my } = this._canvasXY(e);

      let px = Math.floor(2 * FROMCOORD(mx) + 0.5);
      let py = Math.floor(2 * FROMCOORD(my) + 0.5);
      if (!this.state.inUI(px, py)) return;

      // 在周围 1 格内寻找圆点
      let dot: Space | null = null;
      for (let py1 = py - 1; py1 <= py + 1; py1++)
        for (let px1 = px - 1; px1 <= px + 1; px1++) {
          if (
            px1 >= 0 &&
            px1 < this.state.sx &&
            py1 >= 0 &&
            py1 < this.state.sy &&
            mx >= SCOORD(px1 - 1) &&
            mx < SCOORD(px1 + 1) &&
            my >= SCOORD(py1 - 1) &&
            my < SCOORD(py1 + 1) &&
            this.state.sp(px1, py1).flags & F_DOT
          ) {
            dot = this.state.sp(px1, py1);
            px = px1;
            py = py1;
          }
        }

      if (!dot) {
        // 找最近格，检查是否已有归属
        px = Math.floor(2 * FROMCOORD(mx + TILE_SIZE)) - 1;
        py = Math.floor(2 * FROMCOORD(my + TILE_SIZE)) - 1;
        if (px >= 0 && px < this.state.sx && py >= 0 && py < this.state.sy) {
          const sp = this.state.sp(px, py);
          if (sp.flags & F_ASSOC) dot = this.state.sp(sp.dotx, sp.doty);
        }
        if (!dot) return;
      }

      this.ui.dragging = true;
      this.ui.srcx = px;
      this.ui.srcy = py;
      this.ui.dotx = dot.x;
      this.ui.doty = dot.y;
      this.ui.dx = mx;
      this.ui.dy = my;
      this._draw();
    });

    const endDrag = (e: MouseEvent): void => {
      if (!this.ui.dragging) return;
      this.ui.dragging = false;

      const { x: mx, y: my } = this._canvasXY(e);
      const gx = Math.floor(2 * FROMCOORD(mx + TILE_SIZE)) - 1;
      const gy = Math.floor(2 * FROMCOORD(my + TILE_SIZE)) - 1;

      // 落回原点：取消
      if (gx === this.ui.srcx && gy === this.ui.srcy) {
        this._draw();
        return;
      }

      // 源为格（非圆点本身）则先移除其归属
      if (
        (this.ui.srcx !== this.ui.dotx || this.ui.srcy !== this.ui.doty) &&
        this.state.sp(this.ui.srcx, this.ui.srcy).flags & F_ASSOC
      ) {
        removeAssocWithOpposite(this.state, this.state.sp(this.ui.srcx, this.ui.srcy));
      }

      // 目标合法则在此添加归属
      if (this.state.inUI(gx, gy)) {
        const dstTile = this.state.sp(gx, gy);
        const dot = this.state.sp(this.ui.dotx, this.ui.doty);
        if (dstTile && dot && okToAddAssocWithOpposite(this.state, dstTile, dot)) {
          addAssocWithOpposite(this.state, dstTile, dot);
        }
      }

      this._updateColours();
      this._draw();
      this._emitStatus();
    };

    this._on('mouseup', endDrag);
    this._on('mouseleave', endDrag);

    this._on('mousemove', (e) => {
      const { x: mx, y: my } = this._canvasXY(e);

      if (this.ui.dragging) {
        this.ui.dx = mx;
        this.ui.dy = my;
        this._draw();
        return;
      }

      // 计算最近边用于悬停提示
      const coords = coordRoundToEdge(FROMCOORD(mx), FROMCOORD(my));
      const hx = coords.x,
        hy = coords.y;
      if (
        this.state.inUI(hx, hy) &&
        this.state.sp(hx, hy).type === T_EDGE &&
        edgePlacementLegal(this.state, hx, hy)
      ) {
        if (this.ui.hoverX !== hx || this.ui.hoverY !== hy) {
          this.ui.hoverX = hx;
          this.ui.hoverY = hy;
          this._draw();
        }
      } else if (this.ui.hoverX !== null) {
        this.ui.hoverX = null;
        this.ui.hoverY = null;
        this._draw();
      }
    });
  }

  // 公开 API
  newGame(w?: number, h?: number, diff?: number): void {
    this.w = w || this.w;
    this.h = h || this.h;
    if (diff !== undefined) this.diff = diff;
    this.state = generatePuzzle(this.w, this.h, this.diff);
    this.renderer = new Renderer(this.canvas, this.state);
    this.ui.dragging = false;
    this.ui.hoverX = null;
    this.ui.hoverY = null;
    this.colours = null;
    this._flashTime = 0;
    this._updateColours();
    this._draw();
    this._emitStatus();
  }

  setDarkMode(dark: boolean): void {
    this.dark = dark;
    this._draw();
  }

  solve(): void {
    this.state.clear(false);
    const copy = this.state.dup();
    const result = solverState(copy, DIFF_UNREASONABLE);
    if (result === DIFF_IMPOSSIBLE || result === DIFF_AMBIGUOUS) return;
    this.state = copy;
    this.renderer = new Renderer(this.canvas, this.state);
    this.colours = null;
    this._updateColours();
    this._draw();
    this._emitStatus();
  }

  clearBoard(): void {
    this.state.clear(false);
    this._updateColours();
    this._draw();
    this._emitStatus();
  }
}

// ---- React 组件（对齐 galaxies.html 的控制器脚本）--------------------------
const SIZE_OPTIONS = [5, 7, 10, 12, 15] as const;

export default function Galaxies() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<GalaxiesController | null>(null);

  const [size, setSize] = useState<number>(7);
  const [diffMode, setDiffMode] = useState<'normal' | 'unreasonable'>('normal');
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [generating, setGenerating] = useState<boolean>(false);

  const getDiff = (mode: 'normal' | 'unreasonable'): number =>
    mode === 'unreasonable' ? DIFF_UNREASONABLE : DIFF_NORMAL;

  // 初始化控制器 + 主题监听（仅挂载时）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dark =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark';

    const game = new GalaxiesController(canvas, {
      w: 7,
      h: 7,
      diff: DIFF_NORMAL,
      darkMode: dark,
      onStatus: (s) => setStatus(s),
    });
    gameRef.current = game;

    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      game.setDarkMode(isDark);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      observer.disconnect();
      game.destroy();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewGame = () => {
    if (generating) return;
    setGenerating(true);
    // 让「生成中」先渲染，再跑（大棋盘生成可能耗时）
    window.setTimeout(() => {
      gameRef.current?.newGame(size, size, getDiff(diffMode));
      setGenerating(false);
    }, 20);
  };

  const handleSolve = () => {
    gameRef.current?.solve();
  };

  const statusText: string = status
    ? status.completed
      ? `完成！网格 ${status.size}，圆点 ${status.dots}`
      : `网格 ${status.size}，圆点 ${status.dots}`
    : '圆点：0';

  return (
    <div className="puzzle">
      <div className="puzzle-controls">
        <div className="puzzle-controls__group">
          <label className="puzzle-label" htmlFor="galSize">
            网格大小
          </label>
          <select
            id="galSize"
            className="puzzle-select"
            value={size}
            onChange={(e) => setSize(parseInt(e.target.value, 10))}
          >
            {SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}x{s}
              </option>
            ))}
          </select>
        </div>

        <div className="puzzle-controls__group">
          <label className="puzzle-label" htmlFor="galDiff">
            难度
          </label>
          <select
            id="galDiff"
            className="puzzle-select"
            value={diffMode}
            onChange={(e) => setDiffMode(e.target.value as 'normal' | 'unreasonable')}
          >
            <option value="normal">普通</option>
            <option value="unreasonable">困难</option>
          </select>
        </div>

        <button type="button" className="puzzle-btn" onClick={handleNewGame} disabled={generating}>
          {generating ? '生成中…' : '新游戏'}
        </button>
        <button
          type="button"
          className="puzzle-btn puzzle-btn--secondary"
          onClick={handleSolve}
          disabled={generating}
        >
          看答案
        </button>
      </div>

      <div className={`puzzle-status${status?.completed ? ' puzzle-status--done' : ''}`}>
        {statusText}
      </div>

      <div className="puzzle-canvas-wrap">
        <canvas ref={canvasRef} className="puzzle-canvas" aria-label="螺旋星系棋盘" />
      </div>
    </div>
  );
}

// 自包含样式已迁移至 src/styles-scss/pages/game/_puzzle.scss / 编译产物 flask.css
const _UNUSED_GAL_CSS = `
.gal { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
.gal__controls {
  display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; justify-content: center;
}
.gal__group { display: flex; flex-direction: column; gap: 4px; }
.gal__label { font-size: .8rem; font-weight: 600; color: var(--muted, #888); }
.gal__select {
  padding: 7px 12px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .9rem; font-weight: 600; cursor: pointer;
}
.gal__btn {
  padding: 8px 20px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--accent, #3f51b5);
  color: #fff;
  font-size: .95rem; font-weight: 600; cursor: pointer;
}
.gal__btn--secondary { background: var(--surface, #fff); color: var(--ink, #222); }
.gal__btn:hover:not(:disabled) { filter: brightness(1.05); }
.gal__btn:disabled { opacity: .5; cursor: not-allowed; }
.gal__status {
  font-size: 1.05rem; font-weight: 600; min-height: 1.4em; text-align: center;
  color: var(--ink, #222);
}
.gal__status--done { color: var(--accent, #40a02b); }
.gal__canvas-wrap {
  width: 100%;
  display: flex; justify-content: center;
  padding: 8px;
  background: var(--surface, #fff);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: var(--r-sm, 8px);
  overflow-x: auto;
}
.gal__canvas {
  display: block; touch-action: manipulation; cursor: pointer; border-radius: 4px;
  max-width: 100%; height: auto;
}
`;
