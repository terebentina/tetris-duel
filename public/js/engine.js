// Core Tetris game engine: board state, piece movement, gravity,
// line clears and the opponent-inflicted difficulty effects.
// Pure logic — no DOM/canvas — so it runs in Node tests and the browser.

import { PIECES, SevenBag, mulberry32 } from './pieces.js';

export const COLS = 10;
export const ROWS = 22; // top HIDDEN rows are above the visible field
export const HIDDEN = 2;

export const HARD_TYPES = ['S', 'Z'];

const SCORE_TABLE = { 1: 100, 2: 300, 3: 500, 4: 800 };

// Effect pacing (ms)
export const WIND_INTERVAL = 480;
export const SPIN_INTERVAL = 1400;

// Basic wall kicks tried in order when rotating.
const KICKS = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
];

export class Game {
  constructor(seed = Date.now() & 0xffffffff) {
    this.seed = seed;
    this.bag = new SevenBag(seed);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.queue = [this.bag.next(), this.bag.next(), this.bag.next()];
    this.current = null;
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.over = false;
    // Difficulty effects inflicted by the opponent, measured in
    // "pieces remaining under the effect".
    this.hardPieces = 0;
    this.windPieces = 0;
    this.spinPieces = 0;
    this.windDir = 1;
    // timers
    this.gravityAcc = 0;
    this.windAcc = 0;
    this.spinAcc = 0;
    this.softDropping = false;
    // Events for the renderer / network layer to consume each frame:
    // {type:'clear', rows, count} {type:'lock'} {type:'gameover'}
    // {type:'attack', n} {type:'wind', dir} {type:'spin'} {type:'spawn'}
    this.events = [];
    this.spawn();
  }

  gravityInterval() {
    return Math.max(90, 800 - (this.level - 1) * 60);
  }

  spawn() {
    let type;
    if (this.hardPieces > 0) {
      type = HARD_TYPES[Math.floor(this.rng() * HARD_TYPES.length)];
      this.hardPieces--;
    } else {
      type = this.queue.shift();
      this.queue.push(this.bag.next());
    }
    const size = PIECES[type].size;
    const piece = { type, rot: 0, x: Math.floor((COLS - size) / 2), y: 0 };
    this.current = piece;
    this.events.push({ type: 'spawn', piece: type });
    if (this.collides(piece)) {
      this.over = true;
      this.events.push({ type: 'gameover' });
    }
  }

  cellsAt(piece) {
    return PIECES[piece.type].rotations[piece.rot].map(([cx, cy]) => [
      piece.x + cx,
      piece.y + cy,
    ]);
  }

  collides(piece) {
    for (const [x, y] of this.cellsAt(piece)) {
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return true;
      if (this.board[y][x]) return true;
    }
    return false;
  }

  move(dx) {
    if (this.over) return false;
    const p = { ...this.current, x: this.current.x + dx };
    if (this.collides(p)) return false;
    this.current = p;
    return true;
  }

  rotate(dir = 1) {
    if (this.over) return false;
    const rot = (this.current.rot + dir + 4) % 4;
    for (const [kx, ky] of KICKS) {
      const p = { ...this.current, rot, x: this.current.x + kx, y: this.current.y + ky };
      if (!this.collides(p)) {
        this.current = p;
        return true;
      }
    }
    return false;
  }

  // Move the current piece down one row; lock it if it cannot move.
  descend({ scorePerCell = 0 } = {}) {
    if (this.over) return false;
    const p = { ...this.current, y: this.current.y + 1 };
    if (this.collides(p)) {
      this.lock();
      return false;
    }
    this.current = p;
    this.score += scorePerCell;
    return true;
  }

  softDrop() {
    return this.descend({ scorePerCell: 1 });
  }

  hardDrop() {
    if (this.over) return 0;
    let dropped = 0;
    let p = { ...this.current, y: this.current.y + 1 };
    while (!this.collides(p)) {
      this.current = p;
      dropped++;
      p = { ...p, y: p.y + 1 };
    }
    this.score += dropped * 2;
    this.lock();
    return dropped;
  }

  ghostY() {
    let p = { ...this.current };
    let q = { ...p, y: p.y + 1 };
    while (!this.collides(q)) {
      p = q;
      q = { ...q, y: q.y + 1 };
    }
    return p.y;
  }

  lock() {
    const cells = this.cellsAt(this.current);
    for (const [x, y] of cells) {
      this.board[y][x] = this.current.type;
    }
    this.events.push({ type: 'lock' });
    // Topping out: the piece locked entirely above the visible field.
    if (cells.every(([, y]) => y < HIDDEN)) {
      this.over = true;
      this.events.push({ type: 'gameover' });
      return 0;
    }
    // Spend one piece off each active effect counter.
    if (this.windPieces > 0) this.windPieces--;
    if (this.spinPieces > 0) this.spinPieces--;
    const cleared = this.clearLines();
    this.spawn();
    return cleared;
  }

  clearLines() {
    const fullRows = [];
    for (let y = 0; y < ROWS; y++) {
      if (this.board[y].every((c) => c)) fullRows.push(y);
    }
    if (fullRows.length === 0) return 0;
    for (const y of fullRows) {
      this.board.splice(y, 1);
      this.board.unshift(Array(COLS).fill(null));
    }
    const n = fullRows.length;
    this.score += (SCORE_TABLE[n] || 0) * this.level;
    this.lines += n;
    this.level = Math.floor(this.lines / 10) + 1;
    this.events.push({ type: 'clear', rows: fullRows, count: n });
    return n;
  }

  // Opponent cleared `n` lines at once — make life harder over here.
  // 1: next piece(s) are S/Z   2: + wind drift   3: + auto-rotation
  // 4: everything, longer and stronger.
  applyAttack(n) {
    if (this.over) return;
    n = Math.max(1, Math.min(4, n));
    this.hardPieces += n;
    if (n >= 2) {
      this.windPieces += n + 1;
      this.windDir = this.rng() < 0.5 ? -1 : 1;
    }
    if (n >= 3) {
      this.spinPieces += n;
    }
    if (n >= 4) {
      this.hardPieces += 2;
      this.windPieces += 2;
      this.spinPieces += 2;
    }
    this.events.push({ type: 'attack', n });
  }

  // Advance the simulation by dt milliseconds.
  update(dt) {
    if (this.over) return;

    this.gravityAcc += dt;
    const interval = this.softDropping
      ? Math.min(45, this.gravityInterval())
      : this.gravityInterval();
    while (this.gravityAcc >= interval && !this.over) {
      this.gravityAcc -= interval;
      this.descend({ scorePerCell: this.softDropping ? 1 : 0 });
    }

    if (this.windPieces > 0 && !this.over) {
      this.windAcc += dt;
      while (this.windAcc >= WIND_INTERVAL) {
        this.windAcc -= WIND_INTERVAL;
        if (this.rng() < 0.2) this.windDir = -this.windDir;
        if (this.move(this.windDir)) {
          this.events.push({ type: 'wind', dir: this.windDir });
        }
      }
    } else {
      this.windAcc = 0;
    }

    if (this.spinPieces > 0 && !this.over) {
      this.spinAcc += dt;
      while (this.spinAcc >= SPIN_INTERVAL) {
        this.spinAcc -= SPIN_INTERVAL;
        if (this.rotate(1)) this.events.push({ type: 'spin' });
      }
    } else {
      this.spinAcc = 0;
    }
  }

  takeEvents() {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // Compact board snapshot (array of row strings) for network sync.
  snapshot() {
    const rows = this.board.map((row) => row.map((c) => c || '.').join(''));
    return {
      rows,
      current: this.over ? null : { ...this.current },
      score: this.score,
      lines: this.lines,
      level: this.level,
      over: this.over,
    };
  }
}
