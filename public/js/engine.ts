// Core Tetris game engine: board state, piece movement, gravity,
// line clears and the opponent-inflicted difficulty effects.
// Pure logic — no DOM/canvas — so it runs in Node tests and the browser.

import { PIECES, SevenBag, mulberry32 } from './pieces.ts';
import type { Cell, PieceType } from './pieces.ts';

export const COLS = 10;
export const ROWS = 22; // top HIDDEN rows are above the visible field
export const HIDDEN = 2;

export const HARD_TYPES: PieceType[] = ['S', 'Z'];

// Anything that can occupy a settled board cell: a piece colour or garbage.
export type BoardCell = PieceType | 'G';

const SCORE_TABLE: Record<number, number> = { 1: 100, 2: 300, 3: 500, 4: 800 };

// Effect pacing (ms)
export const WIND_INTERVAL = 480;
export const SPIN_INTERVAL = 1400;

// Basic wall kicks tried in order when rotating.
const KICKS: Cell[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
];

export interface ActivePiece {
  type: PieceType;
  rot: number;
  x: number;
  y: number;
}

export type GameEvent =
  | {
      type: 'clear';
      rows: number[];
      count: number;
      // Cell colours of the cleared rows (captured before they vanish),
      // points awarded and current combo streak — all renderer fodder.
      colors: BoardCell[][];
      points: number;
      combo: number;
    }
  | { type: 'lock' }
  | { type: 'gameover' }
  | { type: 'attack'; n: number }
  | { type: 'wind'; dir: number }
  | { type: 'spin' }
  | { type: 'garbage'; n: number }
  | { type: 'spawn'; piece: PieceType };

// Compact board snapshot (array of row strings) for network sync.
export interface Snapshot {
  rows: string[];
  current: ActivePiece | null;
  score: number;
  lines: number;
  level: number;
  over: boolean;
}

export class Game {
  seed: number;
  bag: SevenBag;
  rng: () => number;
  board: (BoardCell | null)[][];
  queue: PieceType[];
  current!: ActivePiece; // assigned by spawn() in the constructor
  score = 0;
  lines = 0;
  level = 1;
  over = false;
  // Consecutive piece locks that cleared at least one line.
  combo = 0;
  // Difficulty effects inflicted by the opponent, measured in
  // "pieces remaining under the effect".
  hardPieces = 0;
  windPieces = 0;
  spinPieces = 0;
  fogPieces = 0; // settled stack is hidden behind fog
  flipPieces = 0; // left/right controls are reversed
  windDir = 1;
  // timers
  gravityAcc = 0;
  windAcc = 0;
  spinAcc = 0;
  softDropping = false;
  // Events for the renderer / network layer to consume each frame:
  // {type:'clear', rows, count, colors, points, combo} {type:'lock'}
  // {type:'gameover'} {type:'attack', n} {type:'wind', dir} {type:'spin'}
  // {type:'garbage', n} {type:'spawn'}
  events: GameEvent[] = [];

  constructor(seed: number = Date.now() & 0xffffffff) {
    this.seed = seed;
    this.bag = new SevenBag(seed);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.board = Array.from({ length: ROWS }, () =>
      Array<BoardCell | null>(COLS).fill(null)
    );
    this.queue = [this.bag.next(), this.bag.next(), this.bag.next()];
    this.spawn();
  }

  gravityInterval(): number {
    return Math.max(90, 800 - (this.level - 1) * 60);
  }

  spawn(): void {
    let type: PieceType;
    if (this.hardPieces > 0) {
      type = HARD_TYPES[Math.floor(this.rng() * HARD_TYPES.length)];
      this.hardPieces--;
    } else {
      type = this.queue.shift()!;
      this.queue.push(this.bag.next());
    }
    const size = PIECES[type].size;
    const piece: ActivePiece = { type, rot: 0, x: Math.floor((COLS - size) / 2), y: 0 };
    this.current = piece;
    this.events.push({ type: 'spawn', piece: type });
    if (this.collides(piece)) {
      this.over = true;
      this.events.push({ type: 'gameover' });
    }
  }

  cellsAt(piece: ActivePiece): Cell[] {
    return PIECES[piece.type].rotations[piece.rot].map<Cell>(([cx, cy]) => [
      piece.x + cx,
      piece.y + cy,
    ]);
  }

  collides(piece: ActivePiece): boolean {
    for (const [x, y] of this.cellsAt(piece)) {
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return true;
      if (this.board[y][x]) return true;
    }
    return false;
  }

  // Player horizontal input — the flip curse reverses it.
  move(dx: number): boolean {
    return this.shift(this.flipPieces > 0 ? -dx : dx);
  }

  // Raw horizontal shift, unaffected by curses (wind uses this directly).
  shift(dx: number): boolean {
    if (this.over) return false;
    const p = { ...this.current, x: this.current.x + dx };
    if (this.collides(p)) return false;
    this.current = p;
    return true;
  }

  rotate(dir = 1): boolean {
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
  descend({ scorePerCell = 0 }: { scorePerCell?: number } = {}): boolean {
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

  softDrop(): boolean {
    return this.descend({ scorePerCell: 1 });
  }

  hardDrop(): number {
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

  ghostY(): number {
    let p = { ...this.current };
    let q = { ...p, y: p.y + 1 };
    while (!this.collides(q)) {
      p = q;
      q = { ...q, y: q.y + 1 };
    }
    return p.y;
  }

  lock(): number {
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
    if (this.fogPieces > 0) this.fogPieces--;
    if (this.flipPieces > 0) this.flipPieces--;
    const cleared = this.clearLines();
    if (cleared === 0) this.combo = 0;
    this.spawn();
    return cleared;
  }

  clearLines(): number {
    const fullRows: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      if (this.board[y].every((c) => c)) fullRows.push(y);
    }
    if (fullRows.length === 0) return 0;
    const colors = fullRows.map((y) => this.board[y].map((c) => c as BoardCell));
    for (const y of fullRows) {
      this.board.splice(y, 1);
      this.board.unshift(Array<BoardCell | null>(COLS).fill(null));
    }
    const n = fullRows.length;
    const points = (SCORE_TABLE[n] || 0) * this.level;
    this.score += points;
    this.lines += n;
    this.level = Math.floor(this.lines / 10) + 1;
    this.combo++;
    this.events.push({
      type: 'clear',
      rows: fullRows,
      count: n,
      colors,
      points,
      combo: this.combo,
    });
    return n;
  }

  // Opponent cleared `n` lines at once — make life harder over here.
  // 1: next piece(s) are S/Z   2: + wind drift
  // 3: + auto-rotation + reversed controls
  // 4: everything, longer and stronger, plus fog and a garbage row.
  applyAttack(n: number): void {
    if (this.over) return;
    n = Math.max(1, Math.min(4, n));
    this.hardPieces += n;
    if (n >= 2) {
      this.windPieces += n + 1;
      this.windDir = this.rng() < 0.5 ? -1 : 1;
    }
    if (n >= 3) {
      this.spinPieces += n;
      this.flipPieces += n;
    }
    if (n >= 4) {
      this.hardPieces += 2;
      this.windPieces += 2;
      this.spinPieces += 2;
      this.flipPieces += 2;
      this.fogPieces += n + 2;
      this.addGarbage(1);
    }
    this.events.push({ type: 'attack', n });
  }

  // Push `n` garbage rows in from the bottom, each with one random hole.
  addGarbage(n: number): void {
    if (this.over) return;
    for (let i = 0; i < n; i++) {
      const hole = Math.floor(this.rng() * COLS);
      this.board.shift();
      this.board.push(
        Array.from({ length: COLS }, (_, x): BoardCell | null =>
          x === hole ? null : 'G'
        )
      );
    }
    this.events.push({ type: 'garbage', n });
    // Lift the falling piece clear of the raised stack; if there is no
    // room left above it, the garbage buries the player.
    let lifted = { ...this.current };
    while (this.collides(lifted) && lifted.y > 0) {
      lifted = { ...lifted, y: lifted.y - 1 };
    }
    if (this.collides(lifted)) {
      this.over = true;
      this.events.push({ type: 'gameover' });
    } else {
      this.current = lifted;
    }
  }

  // Advance the simulation by dt milliseconds.
  update(dt: number): void {
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
        if (this.shift(this.windDir)) {
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

  takeEvents(): GameEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  snapshot(): Snapshot {
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
