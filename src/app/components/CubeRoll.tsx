'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 立方体滚滚（Cube / rolling-polyhedron puzzle）
// 从 Flask 侧 app/static/js/game/cube.js 忠实移植为 React 客户端组件。
// 纯 Canvas 2D 渲染，无外部库依赖；引擎逻辑（多面体数据、网格生成、滚动矩阵
// 变换、涂色互换、关卡生成、渲染、交互）与原实现一一对应。
//
// 玩法（对齐原站文案）：
//   • 多面体坐落在网格上，部分格子为蓝色。
//   • 每当把多面体滚到蓝色格子上时，多面体底面与该格子的颜色互换。
//   • 目标：把多面体所有面都涂成蓝色。
//   • 交互：方向键 / 点击格子周围 / 滑动屏幕来滚动。
//   • 支持立方体、四面体、八面体、二十面体；网格大小 2–8。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

const PI = Math.PI;
const SQ = (x: number): number => x * x;

// ─── 方向常量 ────────────────────────────────────────────────────────────────
const LEFT = 0;
const RIGHT = 1;
const UP = 2;
const DOWN = 3;

// ─── 类型 ────────────────────────────────────────────────────────────────────
type Poly = {
  name?: string;
  order: number;
  nvertices: number;
  vertices: Float32Array;
  nfaces: number;
  faces: Int32Array;
  normals: Float32Array;
  shear: number;
  border: number;
};

type Solid = Poly & { name: string };

interface GridSquare {
  x: number;
  y: number;
  npoints: number;
  points: number[];
  directions: number[];
  flip: boolean;
  tetra_class: number;
}

interface GameState {
  solidIdx: number;
  solid: Solid;
  d1: number;
  d2: number;
  grid: GridSquare[];
  facecolours: Int32Array;
  bluemask: Uint8Array;
  current: number;
  previous: number;
  spkey: Int32Array;
  sgkey: Int32Array;
  dpkey: Int32Array;
  dgkey: Int32Array;
  angle: number;
  completed: number;
  movecount: number;
}

type OldData = { facecolours: Int32Array; bluemask: Uint8Array };

// ─── 多面体数据（对齐 cube.js 的 SOLID_* 常量）──────────────────────────────
const SOLID_TETRAHEDRON: Solid = {
  name: 'Tetrahedron',
  order: 3,
  nvertices: 4,
  vertices: new Float32Array([
    0.0, -0.57735026919, -0.20412414523,
    -0.5, 0.28867513459, -0.20412414523,
    0.0, 0.0, 0.6123724357,
    0.5, 0.28867513459, -0.20412414523,
  ]),
  nfaces: 4,
  faces: new Int32Array([0, 2, 1, 3, 1, 2, 2, 0, 3, 1, 3, 0]),
  normals: new Float32Array([
    -0.816496580928, -0.471404520791, 0.333333333334,
    0.0, 0.942809041583, 0.333333333333,
    0.816496580928, -0.471404520791, 0.333333333334,
    0.0, 0.0, -1.0,
  ]),
  shear: 0.0,
  border: 0.3,
};

const SOLID_CUBE: Solid = {
  name: 'Cube',
  order: 4,
  nvertices: 8,
  vertices: new Float32Array([
    -0.5, -0.5, -0.5, -0.5, -0.5, 0.5,
    -0.5, 0.5, -0.5, -0.5, 0.5, 0.5,
    0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
    0.5, 0.5, -0.5, 0.5, 0.5, 0.5,
  ]),
  nfaces: 6,
  faces: new Int32Array([
    0, 1, 3, 2, 1, 5, 7, 3, 5, 4, 6, 7, 4, 0, 2, 6, 0, 4, 5, 1, 3, 7, 6, 2,
  ]),
  normals: new Float32Array([-1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 1, 0]),
  shear: 0.3,
  border: 0.5,
};

const SOLID_OCTAHEDRON: Solid = {
  name: 'Octahedron',
  order: 3,
  nvertices: 6,
  vertices: new Float32Array([
    -0.5, -0.28867513459472505, 0.4082482904638664,
    0.5, 0.28867513459472505, -0.4082482904638664,
    -0.5, 0.28867513459472505, -0.4082482904638664,
    0.5, -0.28867513459472505, 0.4082482904638664,
    0.0, -0.57735026918945009, -0.4082482904638664,
    0.0, 0.57735026918945009, 0.4082482904638664,
  ]),
  nfaces: 8,
  faces: new Int32Array([
    4, 0, 2, 0, 5, 2, 0, 4, 3, 5, 0, 3, 1, 4, 2, 5, 1, 2, 4, 1, 3, 1, 5, 3,
  ]),
  normals: new Float32Array([
    -0.816496580928, -0.471404520791, -0.333333333334,
    -0.816496580928, 0.471404520791, 0.333333333334,
    0.0, -0.942809041583, 0.333333333333,
    0.0, 0.0, 1.0,
    0.0, 0.0, -1.0,
    0.0, 0.942809041583, -0.333333333333,
    0.816496580928, -0.471404520791, -0.333333333334,
    0.816496580928, 0.471404520791, 0.333333333334,
  ]),
  shear: 0.0,
  border: 0.5,
};

const SOLID_ICOSAHEDRON: Solid = {
  name: 'Icosahedron',
  order: 3,
  nvertices: 12,
  vertices: new Float32Array([
    0.0, 0.57735026919, 0.75576131408,
    0.0, -0.93417235896, 0.17841104489,
    0.0, 0.93417235896, -0.17841104489,
    0.0, -0.57735026919, -0.75576131408,
    -0.5, -0.28867513459, 0.75576131408,
    -0.5, 0.28867513459, -0.75576131408,
    0.5, -0.28867513459, 0.75576131408,
    0.5, 0.28867513459, -0.75576131408,
    -0.80901699437, 0.46708617948, 0.17841104489,
    0.80901699437, 0.46708617948, 0.17841104489,
    -0.80901699437, -0.46708617948, -0.17841104489,
    0.80901699437, -0.46708617948, -0.17841104489,
  ]),
  nfaces: 20,
  faces: new Int32Array([
    8, 0, 2, 0, 9, 2, 1, 10, 3, 11, 1, 3, 0, 4, 6,
    4, 1, 6, 5, 2, 7, 3, 5, 7, 4, 8, 10, 8, 5, 10,
    9, 6, 11, 7, 9, 11, 0, 8, 4, 9, 0, 6, 10, 1, 4,
    1, 11, 6, 8, 2, 5, 2, 9, 7, 3, 10, 5, 11, 3, 7,
  ]),
  normals: new Float32Array([
    -0.356822089773, 0.87267799625, 0.333333333333,
    0.356822089773, 0.87267799625, 0.333333333333,
    -0.356822089773, -0.87267799625, -0.333333333333,
    0.356822089773, -0.87267799625, -0.333333333333,
    0.0, 0.0, 1.0,
    0.0, -0.666666666667, 0.745355992501,
    0.0, 0.666666666667, -0.745355992501,
    0.0, 0.0, -1.0,
    -0.934172358963, -0.12732200375, 0.333333333333,
    -0.934172358963, 0.12732200375, -0.333333333333,
    0.934172358963, -0.12732200375, 0.333333333333,
    0.934172358963, 0.12732200375, -0.333333333333,
    -0.57735026919, 0.333333333334, 0.745355992501,
    0.57735026919, 0.333333333334, 0.745355992501,
    -0.57735026919, -0.745355992501, 0.333333333334,
    0.57735026919, -0.745355992501, 0.333333333334,
    -0.57735026919, 0.745355992501, -0.333333333334,
    0.57735026919, 0.745355992501, -0.333333333334,
    -0.57735026919, -0.333333333334, -0.745355992501,
    0.57735026919, -0.333333333334, -0.745355992501,
  ]),
  shear: 0.0,
  border: 0.8,
};

const SOLIDS: Solid[] = [SOLID_TETRAHEDRON, SOLID_CUBE, SOLID_OCTAHEDRON, SOLID_ICOSAHEDRON];

const SOLID_INDEX: Record<string, number> = {
  TETRAHEDRON: 0,
  CUBE: 1,
  OCTAHEDRON: 2,
  ICOSAHEDRON: 3,
};

// ─── 3×3 矩阵-向量乘（列主序存储）────────────────────────────────────────────
function matmul3(ra: number[], m: number[], a: number[]): void {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  ra[0] = m[0] * x + m[3] * y + m[6] * z;
  ra[1] = m[1] * x + m[4] * y + m[7] * z;
  ra[2] = m[2] * x + m[5] * y + m[8] * z;
}

// ─── 网格生成 ────────────────────────────────────────────────────────────────
function enumGridSquares(solid: Solid, d1: number, d2: number): GridSquare[] {
  const squares: GridSquare[] = [];
  if (solid.order === 4) {
    for (let y = 0; y < d2; y++) {
      for (let x = 0; x < d1; x++) {
        const sq: GridSquare = {
          x,
          y,
          npoints: 4,
          points: [],
          directions: [0, 0, 0, 0],
          flip: false,
          tetra_class: 0,
        };
        sq.points[0] = x - 0.5;
        sq.points[1] = y - 0.5;
        sq.points[2] = x - 0.5;
        sq.points[3] = y + 0.5;
        sq.points[4] = x + 0.5;
        sq.points[5] = y + 0.5;
        sq.points[6] = x + 0.5;
        sq.points[7] = y - 0.5;
        sq.directions[LEFT] = 0x03; // points 0,1
        sq.directions[RIGHT] = 0x0c; // points 2,3
        sq.directions[UP] = 0x09; // points 0,3
        sq.directions[DOWN] = 0x06; // points 1,2
        squares.push(sq);
      }
    }
  } else {
    const theight = Math.sqrt(3) / 2;
    let firstix = -1;
    for (let row = 0; row < d1 + d2; row++) {
      let other: number;
      let rowlen: number;
      if (row < d2) {
        other = 1;
        rowlen = row + d1;
      } else {
        other = -1;
        rowlen = 2 * d2 + d1 - row;
      }
      // down-pointing triangles
      for (let i = 0; i < rowlen; i++) {
        const ix = 2 * i - (rowlen - 1);
        const x = ix * 0.5;
        const y = theight * row;
        const sq: GridSquare = {
          x,
          y: y + theight / 3,
          npoints: 3,
          points: [],
          directions: [0, 0, 0, 0],
          flip: true,
          tetra_class: 0,
        };
        sq.points[0] = x - 0.5;
        sq.points[1] = y;
        sq.points[2] = x;
        sq.points[3] = y + theight;
        sq.points[4] = x + 0.5;
        sq.points[5] = y;
        sq.directions[LEFT] = 0x03; // 0,1
        sq.directions[RIGHT] = 0x06; // 1,2
        sq.directions[UP] = 0x05; // 0,2
        sq.directions[DOWN] = 0; // invalid
        if (firstix < 0) firstix = ix & 3;
        sq.tetra_class = ((row + ((ix - firstix) & 1)) & 2) ^ ((ix - firstix) & 3);
        squares.push(sq);
      }
      // up-pointing triangles
      for (let i = 0; i < rowlen + other; i++) {
        const ix = 2 * i - (rowlen + other - 1);
        const x = ix * 0.5;
        const y = theight * row;
        const sq: GridSquare = {
          x,
          y: y + (2 * theight) / 3,
          npoints: 3,
          points: [],
          directions: [0, 0, 0, 0],
          flip: false,
          tetra_class: 0,
        };
        sq.points[0] = x + 0.5;
        sq.points[1] = y + theight;
        sq.points[2] = x;
        sq.points[3] = y;
        sq.points[4] = x - 0.5;
        sq.points[5] = y + theight;
        sq.directions[LEFT] = 0x06; // 1,2
        sq.directions[RIGHT] = 0x03; // 0,1
        sq.directions[DOWN] = 0x05; // 0,2
        sq.directions[UP] = 0; // invalid
        if (firstix < 0) firstix = (ix - 1) & 3;
        sq.tetra_class = ((row + ((ix - firstix) & 1)) & 2) ^ ((ix - firstix) & 3);
        squares.push(sq);
      }
    }
  }
  return squares;
}

// ─── 多面体与网格对齐 ────────────────────────────────────────────────────────
// 匹配多面体顶点与网格格子的角点。
// 返回 pkey，其中 pkey[j] = 匹配格子角点 j 的多面体顶点索引。
function alignPoly(solid: Poly, sq: GridSquare): Int32Array | null {
  const flipSign = sq.flip ? -1 : 1;

  // 找到多面体的最低 z
  let zmin = Infinity;
  for (let i = 0; i < solid.nvertices; i++) {
    if (zmin > solid.vertices[i * 3 + 2]) zmin = solid.vertices[i * 3 + 2];
  }

  const pkey = new Int32Array(sq.npoints);
  for (let j = 0; j < sq.npoints; j++) {
    let matches = 0;
    let idx = -1;
    for (let i = 0; i < solid.nvertices; i++) {
      const dx = solid.vertices[i * 3] * flipSign - sq.points[j * 2] + sq.x;
      const dy = solid.vertices[i * 3 + 1] * flipSign - sq.points[j * 2 + 1] + sq.y;
      const dz = solid.vertices[i * 3 + 2] - zmin;
      if (SQ(dx) + SQ(dy) + SQ(dz) < 0.1) {
        matches++;
        idx = i;
      }
    }
    if (matches !== 1) return null;
    pkey[j] = idx;
  }
  return pkey;
}

// ─── 找到 z 最低的面（底面）────────────────────────────────────────────────
function lowestFace(solid: Poly): number {
  let best = 0;
  let zmin = 0;
  for (let i = 0; i < solid.nfaces; i++) {
    let z = 0;
    for (let k = 0; k < solid.order; k++) {
      z += solid.vertices[solid.faces[i * solid.order + k] * 3 + 2];
    }
    if (i === 0 || zmin > z) {
      zmin = z;
      best = i;
    }
  }
  return best;
}

// ─── 翻转多面体（镜像 x、y）─────────────────────────────────────────────────
function flipPoly(poly: Poly, doFlip: boolean): void {
  if (!doFlip) return;
  for (let i = 0; i < poly.nvertices; i++) {
    poly.vertices[i * 3] *= -1;
    poly.vertices[i * 3 + 1] *= -1;
  }
  for (let i = 0; i < poly.nfaces; i++) {
    poly.normals[i * 3] *= -1;
    poly.normals[i * 3 + 1] *= -1;
  }
}

// ─── 变换多面体：绕边 (key0,key1) 旋转 angle ─────────────────────────────────
function transformPoly(
  solid: Poly,
  doFlip: boolean,
  key0: number,
  key1: number,
  angle: number,
): Poly {
  // 深拷贝
  const poly: Poly = {
    nvertices: solid.nvertices,
    vertices: new Float32Array(solid.vertices),
    order: solid.order,
    nfaces: solid.nfaces,
    faces: new Int32Array(solid.faces),
    normals: new Float32Array(solid.normals),
    shear: solid.shear,
    border: solid.border,
  };

  flipPoly(poly, doFlip);

  const vx = poly.vertices[key1 * 3] - poly.vertices[key0 * 3];
  const vy = poly.vertices[key1 * 3 + 1] - poly.vertices[key0 * 3 + 1];

  // vmatrix：把边旋到与 x 轴对齐
  const vmatrix = [vx, -vy, 0, vy, vx, 0, 0, 0, 1];

  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  // amatrix：绕 x 轴旋转 angle
  const amatrix = [1, 0, 0, 0, ax, -ay, 0, ay, ax];

  // vmatrix2：vmatrix 的逆
  const vmatrix2 = [vx, vy, 0, -vy, vx, 0, 0, 0, 1];

  // 对顶点与法线应用 vmatrix * amatrix * vmatrix2
  const tmp: number[] = [0, 0, 0];
  for (let i = 0; i < poly.nvertices; i++) {
    const v = [poly.vertices[i * 3], poly.vertices[i * 3 + 1], poly.vertices[i * 3 + 2]];
    matmul3(tmp, vmatrix, v);
    matmul3(v, amatrix, tmp);
    matmul3(tmp, vmatrix2, v);
    poly.vertices[i * 3] = tmp[0];
    poly.vertices[i * 3 + 1] = tmp[1];
    poly.vertices[i * 3 + 2] = tmp[2];
  }
  for (let i = 0; i < poly.nfaces; i++) {
    const n = [poly.normals[i * 3], poly.normals[i * 3 + 1], poly.normals[i * 3 + 2]];
    matmul3(tmp, vmatrix, n);
    matmul3(n, amatrix, tmp);
    matmul3(tmp, vmatrix2, n);
    poly.normals[i * 3] = tmp[0];
    poly.normals[i * 3 + 1] = tmp[1];
    poly.normals[i * 3 + 2] = tmp[2];
  }

  return poly;
}

// ─── 找到移动目标与关键点 ────────────────────────────────────────────────────
type MoveDest = { dest: number; skey: number[]; dkey: number[] };

function findMoveDest(state: GameState, direction: number): MoveDest | null {
  const sq = state.grid[state.current];
  const mask = sq.directions[direction];
  if (mask === 0) return null;

  // 收集两个共享角点
  const skey = [0, 0];
  const pts = [0, 0, 0, 0];
  let j = 0;
  for (let i = 0; i < sq.npoints; i++) {
    if (mask & (1 << i)) {
      pts[j * 2] = sq.points[i * 2];
      pts[j * 2 + 1] = sq.points[i * 2 + 1];
      skey[j] = i;
      j++;
    }
  }

  // 找到共享这两个角点的另一个格子
  for (let i = 0; i < state.grid.length; i++) {
    if (i === state.current) continue;
    const ds = state.grid[i];
    const dkey = [0, 0];
    let match = 0;
    for (let k = 0; k < ds.npoints; k++) {
      const d0 = SQ(ds.points[k * 2] - pts[0]) + SQ(ds.points[k * 2 + 1] - pts[1]);
      if (d0 < 0.1 && match < 2) dkey[match++] = k;
      const d1 = SQ(ds.points[k * 2] - pts[2]) + SQ(ds.points[k * 2 + 1] - pts[3]);
      if (d1 < 0.1 && match < 2) dkey[match++] = k;
    }
    if (match === 2) return { dest: i, skey, dkey };
  }
  return null;
}

// ─── 游戏状态 ────────────────────────────────────────────────────────────────
function createState(solidIdx: number, d1: number, d2: number): GameState {
  const solid = SOLIDS[solidIdx];
  const grid = enumGridSquares(solid, d1, d2);
  const area = grid.length;
  const nfaces = solid.nfaces;

  return {
    solidIdx,
    solid,
    d1,
    d2,
    grid,
    facecolours: new Int32Array(nfaces), // 0=未涂色，1=蓝
    bluemask: new Uint8Array(area), // 格子是否蓝：0 或 1
    current: 0,
    previous: 0,
    spkey: new Int32Array(2),
    sgkey: new Int32Array(2), // 源关键点（用于动画）
    dpkey: new Int32Array(2),
    dgkey: new Int32Array(2), // 目标关键点（静态）
    angle: 0,
    completed: 0,
    movecount: 0,
  };
}

// ─── 执行一次移动 ────────────────────────────────────────────────────────────
function executeMove(state: GameState, direction: number): boolean {
  const md = findMoveDest(state, direction);
  if (!md) return false;

  const { dest, skey } = md;

  // 把源格子的角点索引映射到多面体顶点索引
  const allPkey = alignPoly(state.solid, state.grid[state.current]);
  if (!allPkey) return false;
  const pkey = [allPkey[skey[0]], allPkey[skey[1]]];

  // 找到共享 pkey 两顶点的两个面，计算二面角
  const f: number[] = [];
  for (let i = 0; i < state.solid.nfaces; i++) {
    let match = 0;
    for (let jj = 0; jj < state.solid.order; jj++) {
      const vi = state.solid.faces[i * state.solid.order + jj];
      if (vi === pkey[0] || vi === pkey[1]) match++;
    }
    if (match === 2) f.push(i);
  }
  if (f.length !== 2) return false;

  let dp = 0;
  for (let i = 0; i < 3; i++) {
    dp += state.solid.normals[f[0] * 3 + i] * state.solid.normals[f[1] * 3 + i];
  }
  let angle = Math.acos(Math.max(-1, Math.min(1, dp)));

  // 立方体 UP 的 hack（对齐原始 C 代码）
  if (state.solid.order === 4 && direction === UP) angle = -angle;

  // 尝试变换；若对齐失败则改用负角度
  let poly = transformPoly(state.solid, state.grid[state.current].flip, pkey[0], pkey[1], angle);
  flipPoly(poly, state.grid[dest].flip);
  let ok = alignPoly(poly, state.grid[dest]);

  if (!ok) {
    angle = -angle;
    poly = transformPoly(state.solid, state.grid[state.current].flip, pkey[0], pkey[1], angle);
    flipPoly(poly, state.grid[dest].flip);
    ok = alignPoly(poly, state.grid[dest]);
    if (!ok) return false;
  }

  // 面颜色映射：对每个原面 i，找到法线匹配的 poly 面 j，
  // 则 newcolours[i] = 旧 facecolours[j]。
  const newColours = new Int32Array(state.solid.nfaces).fill(-1);
  for (let i = 0; i < state.solid.nfaces; i++) {
    let nmatch = 0;
    for (let jj = 0; jj < poly.nfaces; jj++) {
      let dist = 0;
      for (let k = 0; k < 3; k++) {
        dist += SQ(poly.normals[jj * 3 + k] - state.solid.normals[i * 3 + k]);
      }
      if (dist < 0.1) {
        nmatch++;
        newColours[i] = state.facecolours[jj];
      }
    }
    if (nmatch !== 1) return false;
  }

  for (let i = 0; i < state.solid.nfaces; i++) {
    state.facecolours[i] = newColours[i];
  }

  state.movecount++;

  // 底面与目标格子互换
  if (!state.completed) {
    const bottom = lowestFace(state.solid);
    const t = state.facecolours[bottom];
    state.facecolours[bottom] = state.bluemask[dest];
    state.bluemask[dest] = t;

    // 检查是否完成
    let allBlue = true;
    for (let i = 0; i < state.solid.nfaces; i++) {
      if (!state.facecolours[i]) allBlue = false;
    }
    if (allBlue) state.completed = state.movecount;
  }

  // 更新用于动画渲染的关键点
  const newPkey = alignPoly(state.solid, state.grid[dest]);
  if (!newPkey) return false;
  state.spkey[0] = pkey[0];
  state.spkey[1] = pkey[1];
  state.sgkey[0] = skey[0];
  state.sgkey[1] = skey[1];
  state.dpkey[0] = newPkey[0];
  state.dpkey[1] = newPkey[1];
  state.dgkey[0] = 0;
  state.dgkey[1] = 1;
  state.previous = state.current;
  state.current = dest;
  state.angle = angle;

  return true;
}

// ─── 关卡生成 ────────────────────────────────────────────────────────────────
function simpleRandom(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

class LCG {
  seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    return this.seed;
  }
}

function generatePuzzle(state: GameState): void {
  const solid = state.solid;
  const area = state.grid.length;
  const rng = new LCG(simpleRandom());

  // 确定该多面体的类别数
  let nclasses: number;
  if (state.solidIdx === 0)
    nclasses = 4; // 四面体
  else if (state.solidIdx === 2)
    nclasses = 2; // 八面体
  else nclasses = 1; // 立方体、二十面体

  const perClass = solid.nfaces / nclasses;

  // 将每个格子分配到一个类别
  const bins: number[][] = Array.from({ length: nclasses }, () => []);
  for (let i = 0; i < area; i++) {
    let cls: number;
    if (nclasses === 4) cls = state.grid[i].tetra_class;
    else if (nclasses === 2) cls = state.grid[i].flip ? 1 : 0;
    else cls = 0;
    bins[cls].push(i);
  }

  // 每个类别选出蓝格（数量等于该类别的面数）
  const flags = new Array<boolean>(area).fill(false);
  for (let c = 0; c < nclasses; c++) {
    // 对该 bin 做 Fisher-Yates 洗牌
    for (let i = bins[c].length - 1; i > 0; i--) {
      const j = rng.next() % (i + 1);
      [bins[c][i], bins[c][j]] = [bins[c][j], bins[c][i]];
    }
    for (let j = 0; j < perClass; j++) flags[bins[c][j]] = true;
  }

  // 收集非蓝格
  const nonBlue: number[] = [];
  for (let i = 0; i < area; i++) if (!flags[i]) nonBlue.push(i);

  // 设置状态
  for (let i = 0; i < area; i++) state.bluemask[i] = flags[i] ? 1 : 0;
  state.facecolours.fill(0);
  state.current = nonBlue[rng.next() % nonBlue.length];

  const pkey = alignPoly(state.solid, state.grid[state.current]);
  if (pkey) {
    state.dpkey[0] = state.spkey[0] = pkey[0];
    state.dpkey[1] = state.spkey[1] = pkey[1];
  }
  state.dgkey[0] = state.sgkey[0] = 0;
  state.dgkey[1] = state.sgkey[1] = 1;
  state.previous = state.current;
  state.angle = 0;
  state.completed = 0;
  state.movecount = 0;
}

// ─── 包围盒 ──────────────────────────────────────────────────────────────────
type BBox = { l: number; r: number; u: number; d: number };

function findBBox(state: GameState): BBox {
  let l = Infinity;
  let r = -Infinity;
  let u = Infinity;
  let d = -Infinity;
  for (const sq of state.grid) {
    for (let i = 0; i < sq.npoints; i++) {
      if (l > sq.points[i * 2]) l = sq.points[i * 2];
      if (r < sq.points[i * 2]) r = sq.points[i * 2];
      if (u > sq.points[i * 2 + 1]) u = sq.points[i * 2 + 1];
      if (d < sq.points[i * 2 + 1]) d = sq.points[i * 2 + 1];
    }
  }
  return { l, r, u, d };
}

// ─── 渲染器（对齐 cube.js 的 render）─────────────────────────────────────────
function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  gridScale: number,
  ox: number,
  oy: number,
  animTime: number,
  dark: boolean,
  oldData: OldData | null,
): void {
  const gs = gridScale;
  const solid = state.solid;

  const bg = dark ? '#1e1e2e' : '#ffffff';
  const border = dark ? '#45475a' : '#585b70';
  const blue = dark ? '#89b4fa' : '#1e66f5';
  const pbg = dark ? '#313244' : '#ccd0da';
  const pblue = dark ? '#89b4fa' : '#1e66f5';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // 判定动画状态
  let square: number;
  let pkey: Int32Array;
  let gkey: Int32Array;
  let angle: number;
  if (animTime < 0) {
    square = state.current;
    pkey = state.dpkey;
    gkey = state.dgkey;
    angle = 0;
  } else {
    const t = Math.min(animTime / 130, 1);
    angle = state.angle * t;
    square = state.previous;
    pkey = state.spkey;
    gkey = state.sgkey;
  }

  // 绘制网格格子
  for (let i = 0; i < state.grid.length; i++) {
    const sq = state.grid[i];
    ctx.beginPath();
    ctx.moveTo(sq.points[0] * gs + ox, sq.points[1] * gs + oy);
    for (let j = 1; j < sq.npoints; j++) {
      ctx.lineTo(sq.points[j * 2] * gs + ox, sq.points[j * 2 + 1] * gs + oy);
    }
    ctx.closePath();
    ctx.fillStyle = (oldData ? oldData.bluemask[i] : state.bluemask[i]) ? blue : bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 变换多面体用于绘制
  const poly = transformPoly(solid, state.grid[square].flip, pkey[0], pkey[1], angle);

  // 计算把关键点对齐到网格的平移量
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let tc = 0;
    for (let j = 0; j < 2; j++) {
      let gc: number;
      if (i < 2) gc = state.grid[square].points[gkey[j] * 2 + i];
      else gc = 0;
      tc += gc - poly.vertices[pkey[j] * 3 + i];
    }
    t[i] = tc / 2;
  }
  for (let i = 0; i < poly.nvertices; i++) {
    for (let j = 0; j < 3; j++) {
      poly.vertices[i * 3 + j] += t[j];
    }
  }

  // 绘制各面（背面剔除）
  for (let i = 0; i < poly.nfaces; i++) {
    const pts: number[] = [];
    for (let j = 0; j < poly.order; j++) {
      const vi = poly.faces[i * poly.order + j];
      const sx = poly.vertices[vi * 3] - poly.vertices[vi * 3 + 2] * poly.shear;
      const sy = poly.vertices[vi * 3 + 1] - poly.vertices[vi * 3 + 2] * poly.shear;
      pts.push(sx, sy);
    }

    // 背面剔除：检查环绕方向
    if (poly.order >= 3) {
      const v1x = pts[2] - pts[0];
      const v1y = pts[3] - pts[1];
      const v2x = pts[4] - pts[2];
      const v2y = pts[5] - pts[3];
      if (v1x * v2y - v1y * v2x <= 0) continue;
    }

    ctx.beginPath();
    ctx.moveTo(Math.floor(pts[0] * gs) + ox, Math.floor(pts[1] * gs) + oy);
    for (let k = 1; k < poly.order; k++) {
      ctx.lineTo(Math.floor(pts[k * 2] * gs) + ox, Math.floor(pts[k * 2 + 1] * gs) + oy);
    }
    ctx.closePath();
    ctx.fillStyle = (oldData ? oldData.facecolours[i] : state.facecolours[i]) ? pblue : pbg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ─── React 组件（对齐 cube.js 的 CubeGame 控制器）────────────────────────────
type SolidKey = 'CUBE' | 'TETRAHEDRON' | 'OCTAHEDRON' | 'ICOSAHEDRON';

const MIN_SCALE = 20;
const MAX_SCALE = 44;

export default function CubeRoll() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 运行时游戏态（命令式，存 ref 以避免绘制耦合 React 渲染）
  const stateRef = useRef<GameState | null>(null);
  const solidIdxRef = useRef<number>(1); // 默认立方体
  const d1Ref = useRef<number>(4);
  const d2Ref = useRef<number>(4);
  const gridScaleRef = useRef<number>(40);
  const oxRef = useRef<number>(0);
  const oyRef = useRef<number>(0);
  const darkRef = useRef<boolean>(false);

  const animatingRef = useRef<boolean>(false);
  const animStartRef = useRef<number>(0);
  const oldDataRef = useRef<OldData | null>(null);

  // 滑动
  const swipeStartXRef = useRef<number>(0);
  const swipeStartYRef = useRef<number>(0);

  // DOM 展示态
  const [solidType, setSolidType] = useState<SolidKey>('CUBE');
  const [sizeValue, setSizeValue] = useState<number>(4);
  const [statusText, setStatusText] = useState<string>('步数：0');
  const [completed, setCompleted] = useState<boolean>(false);

  // ── 渲染 ──
  const draw = useCallback((animTime: number) => {
    const canvas = canvasRef.current;
    const state = stateRef.current;
    if (!canvas || !state) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    render(
      ctx,
      state,
      gridScaleRef.current,
      oxRef.current,
      oyRef.current,
      animTime,
      darkRef.current,
      animTime >= 0 ? oldDataRef.current : null,
    );
  }, []);

  // ── 状态回报 ──
  const emitStatus = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const done = s.completed > 0;
    const moves = s.completed || s.movecount;
    setCompleted(done);
    setStatusText(done ? `完成！共 ${moves} 步` : `步数：${moves}`);
  }, []);

  // ── 自动缩放（对齐 _autoScale）──
  const autoScaleInternal = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    const wrap = wrapRef.current;
    const availWidth = wrap ? wrap.clientWidth - 32 : window.innerWidth - 32;
    const availHeight = window.innerHeight * 0.55;

    const bb = findBBox(state);
    const gridW = bb.r - bb.l + 2 * state.solid.border;
    const gridH = bb.d - bb.u + 2 * state.solid.border;

    const sW = availWidth / gridW;
    const sH = availHeight / gridH;
    const optimal = Math.floor(Math.min(sW, sH));

    gridScaleRef.current = Math.max(MIN_SCALE, Math.min(MAX_SCALE, optimal));
  }, []);

  // ── 重设画布尺寸（对齐 _resizeCanvas）──
  const resizeCanvas = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    const bb = findBBox(state);
    const gs = gridScaleRef.current;
    const w = Math.ceil((bb.r - bb.l + 2 * state.solid.border) * gs);
    const h = Math.ceil((bb.d - bb.u + 2 * state.solid.border) * gs);
    canvas.width = w;
    canvas.height = h;
    oxRef.current = -(bb.l - state.solid.border) * gs;
    oyRef.current = -(bb.u - state.solid.border) * gs;
  }, []);

  // ── 2D 角度 → 移动方向（点击与滑动共用）──
  const angleToDir = useCallback((ang: number): number => {
    const state = stateRef.current;
    if (!state) return LEFT;
    const sq = state.grid[state.current];
    if (sq.npoints === 4) {
      if (Math.abs(ang) > (3 * PI) / 4) return LEFT;
      else if (Math.abs(ang) < PI / 4) return RIGHT;
      else if (ang > 0) return DOWN;
      else return UP;
    } else if (sq.directions[UP] === 0) {
      // 上尖三角
      if (ang < -PI / 2 || ang > (5 * PI) / 6) return LEFT;
      else if (ang > PI / 6) return DOWN;
      else return RIGHT;
    } else {
      // 下尖三角
      if (ang > PI / 2 || ang < (-5 * PI) / 6) return LEFT;
      else if (ang < -PI / 6) return UP;
      else return RIGHT;
    }
  }, []);

  // ── 动画帧 ──
  const animate = useCallback(
    (now: number) => {
      const elapsed = now - animStartRef.current;
      if (elapsed >= 130) {
        animatingRef.current = false;
        draw(-1);
        emitStatus();
        return;
      }
      draw(elapsed);
      requestAnimationFrame(animate);
    },
    [draw, emitStatus],
  );

  // ── 执行一次移动 + 启动动画 ──
  const doMove = useCallback(
    (dir: number) => {
      const state = stateRef.current;
      if (!state) return;
      const oldFacecolours = new Int32Array(state.facecolours);
      const oldBluemask = new Uint8Array(state.bluemask);
      if (!executeMove(state, dir)) return;
      oldDataRef.current = { facecolours: oldFacecolours, bluemask: oldBluemask };
      animatingRef.current = true;
      animStartRef.current = performance.now();
      requestAnimationFrame(animate);
    },
    [animate],
  );

  // ── 新游戏（对齐 newGame）──
  const newGame = useCallback(
    (key: SolidKey, d1: number, d2: number) => {
      const idx = SOLID_INDEX[key];
      solidIdxRef.current = idx !== undefined ? idx : solidIdxRef.current;
      d1Ref.current = d1 || d1Ref.current;
      d2Ref.current = d2 || d2Ref.current;
      const state = createState(solidIdxRef.current, d1Ref.current, d2Ref.current);
      generatePuzzle(state);
      stateRef.current = state;
      animatingRef.current = false;
      autoScaleInternal();
      resizeCanvas();
      draw(-1);
      emitStatus();
    },
    [autoScaleInternal, resizeCanvas, draw, emitStatus],
  );

  // ── 自动缩放公共入口（对齐 autoScale，用于 resize）──
  const autoScale = useCallback(() => {
    autoScaleInternal();
    resizeCanvas();
    draw(-1);
  }, [autoScaleInternal, resizeCanvas, draw]);

  // ── 初始化 + 事件绑定（挂载时执行一次）──
  useEffect(() => {
    darkRef.current =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark';

    // 初始局：默认立方体 4×4
    const state = createState(solidIdxRef.current, d1Ref.current, d2Ref.current);
    generatePuzzle(state);
    stateRef.current = state;
    autoScaleInternal();
    resizeCanvas();
    draw(-1);
    emitStatus();

    const canvas = canvasRef.current;
    const SWIPE_MIN = 15;

    // 桌面：点击画布
    const onClick = (e: MouseEvent) => {
      if (animatingRef.current) return;
      const s = stateRef.current;
      const cv = canvasRef.current;
      if (!s || !cv) return;
      const rect = cv.getBoundingClientRect();
      const scaleX = cv.width / rect.width;
      const scaleY = cv.height / rect.height;
      const mx = (e.clientX - rect.left) * scaleX - oxRef.current;
      const my = (e.clientY - rect.top) * scaleY - oyRef.current;

      const sq = s.grid[s.current];
      const cx = sq.x * gridScaleRef.current;
      const cy = sq.y * gridScaleRef.current;
      const ang = Math.atan2(my - cy, mx - cx);
      const dir = angleToDir(ang);
      const mask = sq.directions[dir];
      if (mask) doMove(dir);
    };

    // 移动端：滑动画布
    const onTouchStart = (e: TouchEvent) => {
      if (animatingRef.current) return;
      if (e.touches.length === 1) {
        swipeStartXRef.current = e.touches[0].clientX;
        swipeStartYRef.current = e.touches[0].clientY;
      }
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (animatingRef.current) return;
      const s = stateRef.current;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - swipeStartXRef.current;
      const dy = t.clientY - swipeStartYRef.current;
      if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;

      const ang = Math.atan2(dy, dx);
      const dir = angleToDir(ang);
      const mask = s.grid[s.current].directions[dir];
      if (mask) doMove(dir);
      e.preventDefault();
    };

    // 键盘
    const onKeyDown = (e: KeyboardEvent) => {
      if (animatingRef.current) return;
      const s = stateRef.current;
      if (!s) return;
      let dir: number;
      if (e.key === 'ArrowLeft') dir = LEFT;
      else if (e.key === 'ArrowRight') dir = RIGHT;
      else if (e.key === 'ArrowUp') dir = UP;
      else if (e.key === 'ArrowDown') dir = DOWN;
      else return;
      e.preventDefault();

      const sq = s.grid[s.current];
      const mask = sq.directions[dir];
      if (mask) doMove(dir);
    };

    if (canvas) {
      canvas.addEventListener('click', onClick);
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    }
    document.addEventListener('keydown', onKeyDown);

    // 窗口 resize（去抖）
    let timer: number | null = null;
    const onResize = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        autoScale();
      }, 150);
    };
    window.addEventListener('resize', onResize);

    // 主题切换观察者（同步暗色调色板并重绘）
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark !== darkRef.current) {
        darkRef.current = dark;
        draw(animatingRef.current ? performance.now() - animStartRef.current : -1);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      if (canvas) {
        canvas.removeEventListener('click', onClick);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchend', onTouchEnd);
      }
      document.removeEventListener('keydown', onKeyDown);
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
    // 仅挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 控件事件 ──
  const onNewGame = useCallback(() => {
    newGame(solidType, sizeValue, sizeValue);
  }, [newGame, solidType, sizeValue]);

  const onSizeInput = useCallback((v: number) => {
    setSizeValue(v);
  }, []);

  return (
    <div className="cube-roll">
      <style>{CUBE_CSS}</style>

      {/* 控制区 */}
      <div className="cube-roll__controls">
        <div className="cube-roll__group">
          <label className="cube-roll__label" htmlFor="cube-solid">
            多面体
          </label>
          <select
            id="cube-solid"
            className="cube-roll__select"
            value={solidType}
            onChange={(e) => setSolidType(e.target.value as SolidKey)}
          >
            <option value="CUBE">立方体 (Cube)</option>
            <option value="TETRAHEDRON">四面体 (Tetrahedron)</option>
            <option value="OCTAHEDRON">八面体 (Octahedron)</option>
            <option value="ICOSAHEDRON">二十面体 (Icosahedron)</option>
          </select>
        </div>
        <div className="cube-roll__group">
          <label className="cube-roll__label" htmlFor="cube-size">
            网格大小
          </label>
          <input
            id="cube-size"
            type="range"
            className="cube-roll__range"
            min={2}
            max={8}
            step={1}
            value={sizeValue}
            onChange={(e) => onSizeInput(parseInt(e.target.value, 10))}
          />
          <span className="cube-roll__range-value">
            {sizeValue}x{sizeValue}
          </span>
        </div>
        <button type="button" className="cube-roll__btn" onClick={onNewGame}>
          新游戏
        </button>
      </div>

      {/* 状态 */}
      <div className={completed ? 'cube-roll__status cube-roll__status--done' : 'cube-roll__status'}>{statusText}</div>

      {/* 画布 */}
      <div className="cube-roll__canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="cube-roll__canvas" aria-label="立方体滚滚棋盘" />
      </div>
    </div>
  );
}

// 自包含样式（Flask 侧无 cube-* 等价 CSS；保留以维持视觉）
const CUBE_CSS = `
.cube-roll { display: flex; flex-direction: column; align-items: center; gap: 16px; width: 100%; }
.cube-roll__controls {
  display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end; justify-content: center;
}
.cube-roll__group { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.cube-roll__label { font-size: .82rem; font-weight: 600; color: var(--muted, #888); }
.cube-roll__select {
  padding: 7px 12px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .92rem; font-weight: 600;
  cursor: pointer;
}
.cube-roll__range { width: 160px; accent-color: var(--accent, #3f51b5); cursor: pointer; }
.cube-roll__range-value { font-size: .82rem; font-weight: 600; color: var(--ink, #222); }
.cube-roll__btn {
  padding: 8px 20px;
  border: 1px solid var(--line-2, #ccc);
  border-radius: var(--r-sm, 8px);
  background: var(--surface, #fff);
  color: var(--ink, #222);
  font-size: .95rem; font-weight: 600;
  cursor: pointer;
}
.cube-roll__btn:hover { background: var(--surface-2, #f5f5f5); }
.cube-roll__status {
  font-size: 1.1rem; font-weight: 600; min-height: 1.4em; text-align: center;
  color: var(--ink, #222);
}
.cube-roll__status--done { color: var(--accent, #1e66f5); }
.cube-roll__canvas-wrap {
  width: 100%;
  display: flex; justify-content: center;
  padding: 8px;
  background: var(--surface, #fff);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: var(--r-sm, 8px);
  overflow-x: auto;
}
.cube-roll__canvas {
  display: block;
  max-width: 100%;
  touch-action: none;
  cursor: pointer;
  border-radius: 4px;
}
`;
