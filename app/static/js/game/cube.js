/**
 * Cube - rolling polyhedron puzzle.
 * Faithful port of Simon Tatham's cube.c.
 *
 * Game: a polyhedron sits on a grid of cells. Some cells are blue.
 * Rolling the polyhedron rotates its faces and swaps its bottom-face
 * colour with the cell it lands on. Paint all faces blue to win.
 */
(function() {
  'use strict';

  const PI = Math.PI;
  const SQ = x => x * x;

  // ---- Direction constants ---------------------------------------------------

  const LEFT = 0, RIGHT = 1, UP = 2, DOWN = 3;

  // ---- Polyhedron data -------------------------------------------------------

  const SOLID_TETRAHEDRON = {
    name: 'Tetrahedron',
    order: 3,
    nvertices: 4,
    vertices: new Float32Array([
       0.0, -0.57735026919, -0.20412414523,
      -0.5,  0.28867513459, -0.20412414523,
       0.0,  0.0,             0.6123724357,
       0.5,  0.28867513459, -0.20412414523,
    ]),
    nfaces: 4,
    faces: new Int32Array([
      0,2,1,  3,1,2,  2,0,3,  1,3,0
    ]),
    normals: new Float32Array([
      -0.816496580928, -0.471404520791,  0.333333333334,
       0.0,             0.942809041583,  0.333333333333,
       0.816496580928, -0.471404520791,  0.333333333334,
       0.0,             0.0,            -1.0,
    ]),
    shear: 0.0,
    border: 0.3,
  };

  const SOLID_CUBE = {
    name: 'Cube',
    order: 4,
    nvertices: 8,
    vertices: new Float32Array([
      -0.5,-0.5,-0.5,  -0.5,-0.5, 0.5,
      -0.5, 0.5,-0.5,  -0.5, 0.5, 0.5,
       0.5,-0.5,-0.5,   0.5,-0.5, 0.5,
       0.5, 0.5,-0.5,   0.5, 0.5, 0.5,
    ]),
    nfaces: 6,
    faces: new Int32Array([
      0,1,3,2,  1,5,7,3,  5,4,6,7,  4,0,2,6,  0,4,5,1,  3,7,6,2
    ]),
    normals: new Float32Array([
      -1,0,0,  0,0,1,  1,0,0,  0,0,-1,  0,-1,0,  0,1,0
    ]),
    shear: 0.3,
    border: 0.5,
  };

  const SOLID_OCTAHEDRON = {
    name: 'Octahedron',
    order: 3,
    nvertices: 6,
    vertices: new Float32Array([
      -0.5, -0.28867513459472505,  0.4082482904638664,
       0.5,  0.28867513459472505, -0.4082482904638664,
      -0.5,  0.28867513459472505, -0.4082482904638664,
       0.5, -0.28867513459472505,  0.4082482904638664,
       0.0, -0.57735026918945009, -0.4082482904638664,
       0.0,  0.57735026918945009,  0.4082482904638664,
    ]),
    nfaces: 8,
    faces: new Int32Array([
      4,0,2,  0,5,2,  0,4,3,  5,0,3,  1,4,2,  5,1,2,  4,1,3,  1,5,3
    ]),
    normals: new Float32Array([
      -0.816496580928, -0.471404520791, -0.333333333334,
      -0.816496580928,  0.471404520791,  0.333333333334,
       0.0,            -0.942809041583,  0.333333333333,
       0.0,             0.0,             1.0,
       0.0,             0.0,            -1.0,
       0.0,             0.942809041583, -0.333333333333,
       0.816496580928, -0.471404520791, -0.333333333334,
       0.816496580928,  0.471404520791,  0.333333333334,
    ]),
    shear: 0.0,
    border: 0.5,
  };

  const SOLID_ICOSAHEDRON = {
    name: 'Icosahedron',
    order: 3,
    nvertices: 12,
    vertices: new Float32Array([
       0.0,          0.57735026919,  0.75576131408,
       0.0,         -0.93417235896,  0.17841104489,
       0.0,          0.93417235896, -0.17841104489,
       0.0,         -0.57735026919, -0.75576131408,
      -0.5,         -0.28867513459,  0.75576131408,
      -0.5,          0.28867513459, -0.75576131408,
       0.5,         -0.28867513459,  0.75576131408,
       0.5,          0.28867513459, -0.75576131408,
      -0.80901699437, 0.46708617948,  0.17841104489,
       0.80901699437, 0.46708617948,  0.17841104489,
      -0.80901699437,-0.46708617948, -0.17841104489,
       0.80901699437,-0.46708617948, -0.17841104489,
    ]),
    nfaces: 20,
    faces: new Int32Array([
      8,0,2,  0,9,2,  1,10,3, 11,1,3,  0,4,6,
      4,1,6,  5,2,7,  3,5,7,  4,8,10,  8,5,10,
      9,6,11, 7,9,11, 0,8,4,  9,0,6,  10,1,4,
      1,11,6, 8,2,5,  2,9,7,  3,10,5, 11,3,7,
    ]),
    normals: new Float32Array([
      -0.356822089773,  0.87267799625,   0.333333333333,
       0.356822089773,  0.87267799625,   0.333333333333,
      -0.356822089773, -0.87267799625,  -0.333333333333,
       0.356822089773, -0.87267799625,  -0.333333333333,
       0.0,             0.0,             1.0,
       0.0,            -0.666666666667,  0.745355992501,
       0.0,             0.666666666667, -0.745355992501,
       0.0,             0.0,            -1.0,
      -0.934172358963, -0.12732200375,   0.333333333333,
      -0.934172358963,  0.12732200375,  -0.333333333333,
       0.934172358963, -0.12732200375,   0.333333333333,
       0.934172358963,  0.12732200375,  -0.333333333333,
      -0.57735026919,   0.333333333334,  0.745355992501,
       0.57735026919,   0.333333333334,  0.745355992501,
      -0.57735026919,  -0.745355992501,  0.333333333334,
       0.57735026919,  -0.745355992501,  0.333333333334,
      -0.57735026919,   0.745355992501, -0.333333333334,
       0.57735026919,   0.745355992501, -0.333333333334,
      -0.57735026919,  -0.333333333334, -0.745355992501,
       0.57735026919,  -0.333333333334, -0.745355992501,
    ]),
    shear: 0.0,
    border: 0.8,
  };

  const SOLIDS = [SOLID_TETRAHEDRON, SOLID_CUBE, SOLID_OCTAHEDRON, SOLID_ICOSAHEDRON];

  // ---- 3x3 matrix-vector multiply (column-major storage) ---------------------

  function matmul3(ra, m, a) {
    const x = a[0], y = a[1], z = a[2];
    ra[0] = m[0]*x + m[3]*y + m[6]*z;
    ra[1] = m[1]*x + m[4]*y + m[7]*z;
    ra[2] = m[2]*x + m[5]*y + m[8]*z;
  }

  // ---- Grid generation -------------------------------------------------------

  function enumGridSquares(solid, d1, d2) {
    const squares = [];
    if (solid.order === 4) {
      for (let y = 0; y < d2; y++) {
        for (let x = 0; x < d1; x++) {
          const sq = {
            x, y,
            npoints: 4,
            points: [],
            directions: [0, 0, 0, 0],
            flip: false,
            tetra_class: 0,
          };
          sq.points[0] = x - 0.5; sq.points[1] = y - 0.5;
          sq.points[2] = x - 0.5; sq.points[3] = y + 0.5;
          sq.points[4] = x + 0.5; sq.points[5] = y + 0.5;
          sq.points[6] = x + 0.5; sq.points[7] = y - 0.5;
          sq.directions[LEFT]  = 0x03;   // points 0,1
          sq.directions[RIGHT] = 0x0C;   // points 2,3
          sq.directions[UP]    = 0x09;   // points 0,3
          sq.directions[DOWN]  = 0x06;   // points 1,2
          squares.push(sq);
        }
      }
    } else {
      const theight = Math.sqrt(3) / 2;
      let firstix = -1;
      for (let row = 0; row < d1 + d2; row++) {
        let other, rowlen;
        if (row < d2) { other = 1; rowlen = row + d1; }
        else          { other = -1; rowlen = 2*d2 + d1 - row; }
        // down-pointing triangles
        for (let i = 0; i < rowlen; i++) {
          const ix = 2*i - (rowlen-1);
          const x = ix * 0.5;
          const y = theight * row;
          const sq = {
            x, y: y + theight/3,
            npoints: 3,
            points: [],
            directions: [0, 0, 0, 0],
            flip: true,
            tetra_class: 0,
          };
          sq.points[0] = x - 0.5; sq.points[1] = y;
          sq.points[2] = x;       sq.points[3] = y + theight;
          sq.points[4] = x + 0.5; sq.points[5] = y;
          sq.directions[LEFT]  = 0x03;   // 0,1
          sq.directions[RIGHT] = 0x06;   // 1,2
          sq.directions[UP]    = 0x05;   // 0,2
          sq.directions[DOWN]  = 0;      // invalid
          if (firstix < 0) firstix = ix & 3;
          sq.tetra_class = ((row + ((ix-firstix)&1)) & 2) ^ ((ix-firstix) & 3);
          squares.push(sq);
        }
        // up-pointing triangles
        for (let i = 0; i < rowlen+other; i++) {
          const ix = 2*i - (rowlen+other-1);
          const x = ix * 0.5;
          const y = theight * row;
          const sq = {
            x, y: y + 2*theight/3,
            npoints: 3,
            points: [],
            directions: [0, 0, 0, 0],
            flip: false,
            tetra_class: 0,
          };
          sq.points[0] = x + 0.5; sq.points[1] = y + theight;
          sq.points[2] = x;       sq.points[3] = y;
          sq.points[4] = x - 0.5; sq.points[5] = y + theight;
          sq.directions[LEFT]  = 0x06;   // 1,2
          sq.directions[RIGHT] = 0x03;   // 0,1
          sq.directions[DOWN]  = 0x05;   // 0,2
          sq.directions[UP]    = 0;      // invalid
          if (firstix < 0) firstix = (ix-1) & 3;
          sq.tetra_class = ((row + ((ix-firstix)&1)) & 2) ^ ((ix-firstix) & 3);
          squares.push(sq);
        }
      }
    }
    return squares;
  }

  function gridArea(solid, d1, d2) {
    if (solid.order === 4) return d1 * d2;
    return d1*d1 + d2*d2 + 4*d1*d2;
  }

  // ---- Polyhedron alignment --------------------------------------------------

  // Match polyhedron vertices to grid square points.
  // Returns array pkey where pkey[j] = polyhedron vertex index matching square point j.
  function alignPoly(solid, sq) {
    const flipSign = sq.flip ? -1 : 1;

    // Find lowest z in the solid
    let zmin = Infinity;
    for (let i = 0; i < solid.nvertices; i++)
      if (zmin > solid.vertices[i*3+2]) zmin = solid.vertices[i*3+2];

    const pkey = new Int32Array(sq.npoints);
    for (let j = 0; j < sq.npoints; j++) {
      let matches = 0, idx = -1;
      for (let i = 0; i < solid.nvertices; i++) {
        const dx = solid.vertices[i*3]   * flipSign - sq.points[j*2]   + sq.x;
        const dy = solid.vertices[i*3+1] * flipSign - sq.points[j*2+1] + sq.y;
        const dz = solid.vertices[i*3+2] - zmin;
        if (SQ(dx) + SQ(dy) + SQ(dz) < 0.1) { matches++; idx = i; }
      }
      if (matches !== 1) return null;
      pkey[j] = idx;
    }
    return pkey;
  }

  // ---- Find the index of the face with lowest z (bottom face) ----------------

  function lowestFace(solid) {
    let best = 0, zmin = 0;
    for (let i = 0; i < solid.nfaces; i++) {
      let z = 0;
      for (let k = 0; k < solid.order; k++)
        z += solid.vertices[solid.faces[i*solid.order + k]*3 + 2];
      if (i === 0 || zmin > z) { zmin = z; best = i; }
    }
    return best;
  }

  // ---- Flip a polyhedron (mirror x and y) -----------------------------------

  function flipPoly(poly, doFlip) {
    if (!doFlip) return;
    for (let i = 0; i < poly.nvertices; i++) {
      poly.vertices[i*3]   *= -1;
      poly.vertices[i*3+1] *= -1;
    }
    for (let i = 0; i < poly.nfaces; i++) {
      poly.normals[i*3]   *= -1;
      poly.normals[i*3+1] *= -1;
    }
  }

  // ---- Transform polyhedron: rotate around edge (key0,key1) by angle --------

  function transformPoly(solid, doFlip, key0, key1, angle) {
    // Deep copy
    const poly = {
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

    const vx = poly.vertices[key1*3]   - poly.vertices[key0*3];
    const vy = poly.vertices[key1*3+1] - poly.vertices[key0*3+1];

    // vmatrix: rotate edge to align with x-axis
    const vmatrix = [vx, -vy, 0, vy, vx, 0, 0, 0, 1];

    const ax = Math.cos(angle), ay = Math.sin(angle);
    // amatrix: rotate around x-axis by angle
    const amatrix = [1, 0, 0, 0, ax, -ay, 0, ay, ax];

    // vmatrix2: inverse of vmatrix
    const vmatrix2 = [vx, vy, 0, -vy, vx, 0, 0, 0, 1];

    // Apply vmatrix * amatrix * vmatrix2 to vertices and normals
    const tmp = [0, 0, 0];
    for (let i = 0; i < poly.nvertices; i++) {
      const v = [poly.vertices[i*3], poly.vertices[i*3+1], poly.vertices[i*3+2]];
      matmul3(tmp, vmatrix, v); matmul3(v, amatrix, tmp); matmul3(tmp, vmatrix2, v);
      poly.vertices[i*3] = tmp[0]; poly.vertices[i*3+1] = tmp[1]; poly.vertices[i*3+2] = tmp[2];
    }
    for (let i = 0; i < poly.nfaces; i++) {
      const n = [poly.normals[i*3], poly.normals[i*3+1], poly.normals[i*3+2]];
      matmul3(tmp, vmatrix, n); matmul3(n, amatrix, tmp); matmul3(tmp, vmatrix2, n);
      poly.normals[i*3] = tmp[0]; poly.normals[i*3+1] = tmp[1]; poly.normals[i*3+2] = tmp[2];
    }

    return poly;
  }

  // ---- Find move destination and key points ----------------------------------

  function findMoveDest(state, direction) {
    const sq = state.grid[state.current];
    const mask = sq.directions[direction];
    if (mask === 0) return null;

    // Collect the two shared points
    const skey = [0, 0];
    const pts = [0, 0, 0, 0];
    let j = 0;
    for (let i = 0; i < sq.npoints; i++) {
      if (mask & (1 << i)) {
        pts[j*2]   = sq.points[i*2];
        pts[j*2+1] = sq.points[i*2+1];
        skey[j] = i;
        j++;
      }
    }

    // Find other square sharing these two points
    for (let i = 0; i < state.grid.length; i++) {
      if (i === state.current) continue;
      const ds = state.grid[i];
      let dkey = [0, 0], match = 0;
      for (let k = 0; k < ds.npoints; k++) {
        const d0 = SQ(ds.points[k*2] - pts[0]) + SQ(ds.points[k*2+1] - pts[1]);
        if (d0 < 0.1 && match < 2) dkey[match++] = k;
        const d1 = SQ(ds.points[k*2] - pts[2]) + SQ(ds.points[k*2+1] - pts[3]);
        if (d1 < 0.1 && match < 2) dkey[match++] = k;
      }
      if (match === 2) return { dest: i, skey, dkey };
    }
    return null;
  }

  // ---- Game state ------------------------------------------------------------

  function createState(solidIdx, d1, d2) {
    const solid = SOLIDS[solidIdx];
    const grid = enumGridSquares(solid, d1, d2);
    const area = grid.length;
    const nfaces = solid.nfaces;

    return {
      solidIdx,
      solid,
      d1, d2,
      grid,
      facecolours: new Int32Array(nfaces),        // 0=uncolored, 1=blue
      bluemask: new Uint8Array(area),              // grid cell blue: 0 or 1
      current: 0,
      previous: 0,
      spkey: new Int32Array(2), sgkey: new Int32Array(2),   // source keys (for anim)
      dpkey: new Int32Array(2), dgkey: new Int32Array(2),   // dest keys (static)
      angle: 0,
      completed: 0,
      movecount: 0,
    };
  }

  // ---- Execute a move --------------------------------------------------------

  function executeMove(state, direction) {
    const md = findMoveDest(state, direction);
    if (!md) return false;

    const { dest, skey, dkey } = md;

    // Map grid-point indices to polyhedron-vertex indices for the source square
    const allPkey = alignPoly(state.solid, state.grid[state.current]);
    if (!allPkey) return false;
    const pkey = [allPkey[skey[0]], allPkey[skey[1]]];

    // Find the two faces sharing both pkey vertices, compute dihedral angle
    const f = [];
    for (let i = 0; i < state.solid.nfaces; i++) {
      let match = 0;
      for (let j = 0; j < state.solid.order; j++) {
        const vi = state.solid.faces[i*state.solid.order + j];
        if (vi === pkey[0] || vi === pkey[1]) match++;
      }
      if (match === 2) f.push(i);
    }
    if (f.length !== 2) return false;

    let dp = 0;
    for (let i = 0; i < 3; i++)
      dp += state.solid.normals[f[0]*3+i] * state.solid.normals[f[1]*3+i];
    let angle = Math.acos(Math.max(-1, Math.min(1, dp)));

    // Cube UP hack (matches original C code)
    if (state.solid.order === 4 && direction === UP) angle = -angle;

    // Try transform; if alignment fails, try negative angle
    let poly = transformPoly(state.solid,
                              state.grid[state.current].flip,
                              pkey[0], pkey[1], angle);
    flipPoly(poly, state.grid[dest].flip);
    let ok = alignPoly(poly, state.grid[dest]);

    if (!ok) {
      angle = -angle;
      poly = transformPoly(state.solid,
                            state.grid[state.current].flip,
                            pkey[0], pkey[1], angle);
      flipPoly(poly, state.grid[dest].flip);
      ok = alignPoly(poly, state.grid[dest]);
      if (!ok) return false;
    }

    // Map face colours: for each original face i, find which poly face j
    // has the matching normal, then newcolours[i] = old facecolours[j].
    const newColours = new Int32Array(state.solid.nfaces).fill(-1);
    for (let i = 0; i < state.solid.nfaces; i++) {
      let nmatch = 0;
      for (let j = 0; j < poly.nfaces; j++) {
        let dist = 0;
        for (let k = 0; k < 3; k++)
          dist += SQ(poly.normals[j*3+k] - state.solid.normals[i*3+k]);
        if (dist < 0.1) { nmatch++; newColours[i] = state.facecolours[j]; }
      }
      if (nmatch !== 1) return false;
    }

    for (let i = 0; i < state.solid.nfaces; i++)
      state.facecolours[i] = newColours[i];

    state.movecount++;

    // Swap bottom face with destination square
    if (!state.completed) {
      const bottom = lowestFace(state.solid);
      const t = state.facecolours[bottom];
      state.facecolours[bottom] = state.bluemask[dest];
      state.bluemask[dest] = t;

      // Check completion
      let allBlue = true;
      for (let i = 0; i < state.solid.nfaces; i++)
        if (!state.facecolours[i]) allBlue = false;
      if (allBlue) state.completed = state.movecount;
    }

    // Update key points for animation rendering
    const newPkey = alignPoly(state.solid, state.grid[dest]);
    state.spkey[0] = pkey[0]; state.spkey[1] = pkey[1];
    state.sgkey[0] = skey[0]; state.sgkey[1] = skey[1];
    state.dpkey[0] = newPkey[0]; state.dpkey[1] = newPkey[1];
    state.dgkey[0] = 0; state.dgkey[1] = 1;
    state.previous = state.current;
    state.current = dest;
    state.angle = angle;

    return true;
  }

  // ---- Puzzle generation -----------------------------------------------------

  function simpleRandom() {
    return Math.floor(Math.random() * 0x7FFFFFFF);
  }

  class LCG {
    constructor(seed) { this.seed = seed >>> 0; }
    next() { this.seed = (this.seed * 1103515245 + 12345) >>> 0; return this.seed; }
  }

  function generatePuzzle(state) {
    const solid = state.solid;
    const area = state.grid.length;
    const rng = new LCG(simpleRandom());

    // Determine class count for this solid
    let nclasses;
    if (state.solidIdx === 0) nclasses = 4;          // tetrahedron
    else if (state.solidIdx === 2) nclasses = 2;      // octahedron
    else nclasses = 1;                                // cube, icosahedron

    const perClass = solid.nfaces / nclasses;

    // Assign each grid square to a class
    const bins = Array.from({length: nclasses}, () => []);
    for (let i = 0; i < area; i++) {
      let cls;
      if (nclasses === 4) cls = state.grid[i].tetra_class;
      else if (nclasses === 2) cls = state.grid[i].flip ? 1 : 0;
      else cls = 0;
      bins[cls].push(i);
    }

    // Pick blue squares per class (equal to faces per class)
    const flags = new Array(area).fill(false);
    for (let c = 0; c < nclasses; c++) {
      // Shuffle using Fisher-Yates on the bin
      for (let i = bins[c].length - 1; i > 0; i--) {
        const j = rng.next() % (i + 1);
        [bins[c][i], bins[c][j]] = [bins[c][j], bins[c][i]];
      }
      for (let j = 0; j < perClass; j++)
        flags[bins[c][j]] = true;
    }

    // Collect non-blue squares
    const nonBlue = [];
    for (let i = 0; i < area; i++) if (!flags[i]) nonBlue.push(i);

    // Set up state
    for (let i = 0; i < area; i++) state.bluemask[i] = flags[i] ? 1 : 0;
    state.facecolours.fill(0);
    state.current = nonBlue[rng.next() % nonBlue.length];

    const pkey = alignPoly(state.solid, state.grid[state.current]);
    state.dpkey[0] = state.spkey[0] = pkey[0];
    state.dpkey[1] = state.spkey[1] = pkey[1];
    state.dgkey[0] = state.sgkey[0] = 0;
    state.dgkey[1] = state.sgkey[1] = 1;
    state.previous = state.current;
    state.angle = 0;
    state.completed = 0;
    state.movecount = 0;
  }

  // ---- Bounding box ----------------------------------------------------------

  function findBBox(state) {
    let l = Infinity, r = -Infinity, u = Infinity, d = -Infinity;
    for (const sq of state.grid) {
      for (let i = 0; i < sq.npoints; i++) {
        if (l > sq.points[i*2]) l = sq.points[i*2];
        if (r < sq.points[i*2]) r = sq.points[i*2];
        if (u > sq.points[i*2+1]) u = sq.points[i*2+1];
        if (d < sq.points[i*2+1]) d = sq.points[i*2+1];
      }
    }
    return { l, r, u, d };
  }

  // ---- Renderer --------------------------------------------------------------

  function render(ctx, state, gridScale, ox, oy, animTime, dark, oldData) {
    const gs = gridScale;
    const solid = state.solid;

    const bg    = dark ? '#1e1e2e' : '#ffffff';
    const fg    = dark ? '#cdd6f4' : '#11111b';
    const border= dark ? '#45475a' : '#585b70';
    const blue  = dark ? '#89b4fa' : '#1e66f5';
    const pbg   = dark ? '#313244' : '#ccd0da';
    const pblue = dark ? '#89b4fa' : '#1e66f5';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // Determine animation state
    let square, pkey, gkey, angle;
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

    // Draw grid cells
    for (let i = 0; i < state.grid.length; i++) {
      const sq = state.grid[i];
      ctx.beginPath();
      ctx.moveTo(sq.points[0]*gs + ox, sq.points[1]*gs + oy);
      for (let j = 1; j < sq.npoints; j++)
        ctx.lineTo(sq.points[j*2]*gs + ox, sq.points[j*2+1]*gs + oy);
      ctx.closePath();
      ctx.fillStyle = (oldData ? oldData.bluemask[i] : state.bluemask[i]) ? blue : bg;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Transform polyhedron for drawing
    let poly = transformPoly(solid,
                              state.grid[square].flip,
                              pkey[0], pkey[1], angle);

    // Compute translation to align key points with grid
    const t = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      let tc = 0;
      for (let j = 0; j < 2; j++) {
        let gc;
        if (i < 2) gc = state.grid[square].points[gkey[j]*2 + i];
        else gc = 0;
        tc += (gc - poly.vertices[pkey[j]*3 + i]);
      }
      t[i] = tc / 2;
    }
    for (let i = 0; i < poly.nvertices; i++)
      for (let j = 0; j < 3; j++)
        poly.vertices[i*3+j] += t[j];

    // Draw faces (back-face culled)
    for (let i = 0; i < poly.nfaces; i++) {
      const pts = [];
      for (let j = 0; j < poly.order; j++) {
        const vi = poly.faces[i*poly.order + j];
        const sx = poly.vertices[vi*3]   - poly.vertices[vi*3+2] * poly.shear;
        const sy = poly.vertices[vi*3+1] - poly.vertices[vi*3+2] * poly.shear;
        pts.push(sx, sy);
      }

      // Back-face cull: check winding order
      if (poly.order >= 3) {
        const v1x = pts[2] - pts[0], v1y = pts[3] - pts[1];
        const v2x = pts[4] - pts[2], v2y = pts[5] - pts[3];
        if (v1x*v2y - v1y*v2x <= 0) continue;
      }

      ctx.beginPath();
      ctx.moveTo(Math.floor(pts[0]*gs) + ox, Math.floor(pts[1]*gs) + oy);
      for (let k = 1; k < poly.order; k++)
        ctx.lineTo(Math.floor(pts[k*2]*gs) + ox, Math.floor(pts[k*2+1]*gs) + oy);
      ctx.closePath();
      ctx.fillStyle = (oldData ? oldData.facecolours[i] : state.facecolours[i]) ? pblue : pbg;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ---- Controller ------------------------------------------------------------

  window.CubeGame = class CubeGame {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');

      const idx = {TETRAHEDRON:0, CUBE:1, OCTAHEDRON:2, ICOSAHEDRON:3}[opts.solidType];
      this.solidIdx = idx !== undefined ? idx : 1;
      this.d1 = opts.d1 || 4;
      this.d2 = opts.d2 || 4;
      this.gridScale = opts.gridScale || 40;
      this.dark = opts.darkMode || false;

      this.state = createState(this.solidIdx, this.d1, this.d2);
      generatePuzzle(this.state);

      this.animating = false;
      this.animStart = 0;
      this.onStatus = opts.onStatus || (() => {});

      this._resizeCanvas();
      this._draw(-1);
      this._emitStatus();
      this._bindEvents();
    }

    _resizeCanvas() {
      const bb = findBBox(this.state);
      const gs = this.gridScale;
      const w = Math.ceil((bb.r - bb.l + 2*this.state.solid.border) * gs);
      const h = Math.ceil((bb.d - bb.u + 2*this.state.solid.border) * gs);
      this.canvas.width = w;
      this.canvas.height = h;
      this.ox = -(bb.l - this.state.solid.border) * gs;
      this.oy = -(bb.u - this.state.solid.border) * gs;
    }

    _draw(animTime) {
      render(this.ctx, this.state, this.gridScale, this.ox, this.oy, animTime, this.dark,
             animTime >= 0 ? this.oldData : null);
    }

    _emitStatus() {
      const s = this.state;
      this.onStatus({
        completed: s.completed > 0,
        moves: s.completed || s.movecount,
        solid: SOLIDS[this.solidIdx].name,
      });
    }

    _bindEvents() {
      this.canvas.addEventListener('click', e => {
        if (this.animating) return;
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX - this.ox;
        const my = (e.clientY - rect.top) * scaleY - this.oy;

        const sq = this.state.grid[this.state.current];
        const cx = sq.x * this.gridScale;
        const cy = sq.y * this.gridScale;
        const ang = Math.atan2(my - cy, mx - cx);
        let dir;

        if (sq.npoints === 4) {
          if (Math.abs(ang) > 3*PI/4)      dir = LEFT;
          else if (Math.abs(ang) < PI/4)   dir = RIGHT;
          else if (ang > 0)                 dir = DOWN;
          else                              dir = UP;
        } else if (sq.directions[UP] === 0) {
          // Up-pointing triangle
          if (ang < -PI/2 || ang > 5*PI/6) dir = LEFT;
          else if (ang > PI/6)              dir = DOWN;
          else                              dir = RIGHT;
        } else {
          // Down-pointing triangle
          if (ang > PI/2 || ang < -5*PI/6) dir = LEFT;
          else if (ang < -PI/6)             dir = UP;
          else                              dir = RIGHT;
        }

        const mask = this.state.grid[this.state.current].directions[dir];
        if (mask) this._doMove(dir);
      });

      document.addEventListener('keydown', e => {
        if (this.animating) return;
        let dir;
        if (e.key === 'ArrowLeft') dir = LEFT;
        else if (e.key === 'ArrowRight') dir = RIGHT;
        else if (e.key === 'ArrowUp') dir = UP;
        else if (e.key === 'ArrowDown') dir = DOWN;
        else return;
        e.preventDefault();

        // Allow diagonal movement for triangle grids via key sequences
        const sq = this.state.grid[this.state.current];
        const mask = sq.directions[dir];
        if (mask) this._doMove(dir);
      });
    }

    _doMove(dir) {
      const oldFacecolours = new Int32Array(this.state.facecolours);
      const oldBluemask = new Uint8Array(this.state.bluemask);
      if (!executeMove(this.state, dir)) return;
      this.oldData = { facecolours: oldFacecolours, bluemask: oldBluemask };
      this.animating = true;
      this.animStart = performance.now();
      requestAnimationFrame(t => this._animate(t));
    }

    _animate(now) {
      const elapsed = now - this.animStart;
      if (elapsed >= 130) {
        this.animating = false;
        this._draw(-1);
        this._emitStatus();
        return;
      }
      this._draw(elapsed);
      requestAnimationFrame(t => this._animate(t));
    }

    // Public API
    newGame(solidType, d1, d2) {
      const idx = {TETRAHEDRON:0, CUBE:1, OCTAHEDRON:2, ICOSAHEDRON:3}[solidType];
      this.solidIdx = idx !== undefined ? idx : this.solidIdx;
      this.d1 = d1 || this.d1;
      this.d2 = d2 || this.d2;
      this.state = createState(this.solidIdx, this.d1, this.d2);
      generatePuzzle(this.state);
      this.animating = false;
      this._resizeCanvas();
      this._draw(-1);
      this._emitStatus();
    }

    setDarkMode(dark) {
      this.dark = dark;
      this._draw(this.animating ? performance.now() - this.animStart : -1);
    }

    getSolidName() { return SOLIDS[this.solidIdx].name; }
  };
})();
