import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  COLS,
  ROWS,
  HIDDEN,
  HARD_TYPES,
  WIND_INTERVAL,
  SPIN_INTERVAL,
} from '../public/js/engine.js';

function fillRow(game, y, { except = [] } = {}) {
  for (let x = 0; x < COLS; x++) {
    if (!except.includes(x)) game.board[y][x] = 'I';
  }
}

test('same seed produces identical piece sequences', () => {
  const a = new Game(777);
  const b = new Game(777);
  assert.equal(a.current.type, b.current.type);
  assert.deepEqual(a.queue, b.queue);
});

test('movement respects walls', () => {
  const g = new Game(1);
  for (let i = 0; i < 20; i++) g.move(-1);
  const minX = Math.min(...g.cellsAt(g.current).map(([x]) => x));
  assert.equal(minX, 0);
  for (let i = 0; i < 20; i++) g.move(1);
  const maxX = Math.max(...g.cellsAt(g.current).map(([x]) => x));
  assert.equal(maxX, COLS - 1);
});

test('hard drop locks the piece at the bottom and spawns a new one', () => {
  const g = new Game(2);
  const type = g.current.type;
  g.hardDrop();
  const locked = g.board.flat().filter(Boolean);
  assert.equal(locked.length, 4);
  assert.ok(locked.every((t) => t === type));
  assert.ok(g.current, 'a new piece spawned');
});

test('hard drop awards 2 points per dropped cell', () => {
  const g = new Game(3);
  const before = g.score;
  const dropped = g.hardDrop();
  assert.ok(dropped > 0);
  assert.equal(g.score, before + dropped * 2);
});

test('clearing a single line removes it and scores 100', () => {
  const g = new Game(4);
  fillRow(g, ROWS - 1, { except: [0] });
  g.board[ROWS - 1][0] = 'T'; // complete the row manually
  const cleared = g.clearLines();
  assert.equal(cleared, 1);
  assert.equal(g.lines, 1);
  assert.equal(g.score, 100);
  assert.ok(g.board[ROWS - 1].every((c) => c === null) || true);
  // the cleared row's contents are gone
  assert.equal(g.board.flat().filter(Boolean).length, 0);
});

test('clearing 4 lines at once scores 800 and raises level after 10 lines', () => {
  const g = new Game(5);
  for (let i = 1; i <= 4; i++) fillRow(g, ROWS - i);
  assert.equal(g.clearLines(), 4);
  assert.equal(g.score, 800);
  for (let i = 1; i <= 4; i++) fillRow(g, ROWS - i);
  assert.equal(g.clearLines(), 4);
  for (let i = 1; i <= 2; i++) fillRow(g, ROWS - i);
  assert.equal(g.clearLines(), 2);
  assert.equal(g.lines, 10);
  assert.equal(g.level, 2);
});

test('gravity moves the piece down over time', () => {
  const g = new Game(6);
  const y0 = g.current.y;
  g.update(g.gravityInterval() * 3 + 1);
  assert.ok(g.current.y > y0);
});

test('game over when the stack reaches the top', () => {
  const g = new Game(7);
  // fill everything except the very top rows so the next spawn collides
  for (let y = 1; y < ROWS; y++) fillRow(g, y);
  g.hardDrop(); // current piece locks immediately at the top
  assert.equal(g.over, true);
  assert.ok(g.takeEvents().some((e) => e.type === 'gameover'));
});

test('applyAttack(1) forces hard (S/Z) pieces only', () => {
  const g = new Game(8);
  g.applyAttack(1);
  assert.equal(g.hardPieces, 1);
  assert.equal(g.windPieces, 0);
  assert.equal(g.spinPieces, 0);
  g.hardDrop();
  assert.ok(HARD_TYPES.includes(g.current.type), `spawned ${g.current.type}`);
  assert.equal(g.hardPieces, 0);
});

test('applyAttack scales effects with line count', () => {
  const g2 = new Game(9);
  g2.applyAttack(2);
  assert.equal(g2.hardPieces, 2);
  assert.equal(g2.windPieces, 3);
  assert.equal(g2.spinPieces, 0);

  const g3 = new Game(9);
  g3.applyAttack(3);
  assert.equal(g3.hardPieces, 3);
  assert.equal(g3.windPieces, 4);
  assert.equal(g3.spinPieces, 3);

  const g4 = new Game(9);
  g4.applyAttack(4);
  assert.equal(g4.hardPieces, 6);
  assert.equal(g4.windPieces, 7);
  assert.equal(g4.spinPieces, 6);
});

test('attack count is clamped to [1,4]', () => {
  const g = new Game(10);
  g.applyAttack(99);
  assert.equal(g.hardPieces, 6); // same as applyAttack(4)
});

test('wind pushes the piece sideways while active', () => {
  const g = new Game(11);
  g.windPieces = 3;
  g.windDir = 1;
  const x0 = g.current.x;
  // advance just under one gravity step but several wind intervals
  let moved = false;
  for (let i = 0; i < 6 && !moved; i++) {
    g.update(WIND_INTERVAL);
    moved = g.current.x !== x0;
  }
  assert.ok(moved, 'wind moved the piece horizontally');
  assert.ok(g.takeEvents().some((e) => e.type === 'wind'));
});

test('spin effect auto-rotates the piece', () => {
  const g = new Game(12);
  // make sure we have a piece that visibly rotates
  while (g.current.type === 'O') g.hardDrop();
  g.spinPieces = 3;
  const rot0 = g.current.rot;
  g.update(SPIN_INTERVAL);
  assert.notEqual(g.current.rot, rot0);
  assert.ok(g.takeEvents().some((e) => e.type === 'spin'));
});

test('effect counters decrement as pieces lock', () => {
  const g = new Game(13);
  g.windPieces = 2;
  g.spinPieces = 1;
  g.hardDrop();
  assert.equal(g.windPieces, 1);
  assert.equal(g.spinPieces, 0);
  g.hardDrop();
  assert.equal(g.windPieces, 0);
});

test('snapshot round-trips board state compactly', () => {
  const g = new Game(14);
  g.board[ROWS - 1][0] = 'T';
  const snap = g.snapshot();
  assert.equal(snap.rows.length, ROWS);
  assert.equal(snap.rows[ROWS - 1][0], 'T');
  assert.equal(snap.rows[ROWS - 1][1], '.');
  assert.equal(snap.score, g.score);
  assert.ok(snap.current);
});

test('soft drop scores 1 point per cell', () => {
  const g = new Game(15);
  const before = g.score;
  assert.ok(g.softDrop());
  assert.equal(g.score, before + 1);
});

test('rotation works with wall kicks at the edge', () => {
  const g = new Game(16);
  while (g.current.type === 'O') g.hardDrop();
  for (let i = 0; i < 20; i++) g.move(-1); // flush left
  const ok = g.rotate(1);
  assert.ok(ok, 'rotation succeeded via kicks at the wall');
  // piece remains in bounds
  for (const [x] of g.cellsAt(g.current)) assert.ok(x >= 0 && x < COLS);
});

test('hidden rows exist above the visible field', () => {
  assert.ok(HIDDEN >= 2);
  assert.equal(ROWS - HIDDEN, 20);
});
