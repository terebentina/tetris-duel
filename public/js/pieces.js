// Tetromino definitions, seeded RNG and the 7-bag randomizer.
// Shared between the browser client and Node tests (pure ES module).

export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export const COLORS = {
  I: '#00e5ff',
  O: '#ffd500',
  T: '#b517e8',
  S: '#19d24b',
  Z: '#ff3355',
  J: '#2266ff',
  L: '#ff9100',
};

// Base shapes inside their rotation bounding box ('X' = filled cell).
const BASE_SHAPES = {
  I: ['....', 'XXXX', '....', '....'],
  O: ['XX', 'XX'],
  T: ['.X.', 'XXX', '...'],
  S: ['.XX', 'XX.', '...'],
  Z: ['XX.', '.XX', '...'],
  J: ['X..', 'XXX', '...'],
  L: ['..X', 'XXX', '...'],
};

function matrixFromStrings(rows) {
  return rows.map((r) => [...r].map((c) => (c === 'X' ? 1 : 0)));
}

function rotateCW(m) {
  const n = m.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out[x][n - 1 - y] = m[y][x];
    }
  }
  return out;
}

function cellsOf(m) {
  const cells = [];
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x]) cells.push([x, y]);
    }
  }
  return cells;
}

// PIECES[type] = { size, rotations: [cells0, cells1, cells2, cells3] }
// where cellsN is an array of [x, y] offsets inside the bounding box.
export const PIECES = {};
for (const type of TYPES) {
  let m = matrixFromStrings(BASE_SHAPES[type]);
  const rotations = [];
  for (let r = 0; r < 4; r++) {
    rotations.push(cellsOf(m));
    m = rotateCW(m);
  }
  PIECES[type] = { size: m.length, rotations };
}

// Deterministic, seedable PRNG (mulberry32). Returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SevenBag {
  constructor(seed) {
    this.rng = mulberry32(seed);
    this.bag = [];
  }

  next() {
    if (this.bag.length === 0) {
      this.bag = [...TYPES];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }
}
