// Fuzz: play many full games with random inputs and random incoming
// attacks. The engine must never throw, corrupt the board, or leave a
// piece out of bounds, and every game must eventually end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, COLS, ROWS } from '../public/js/engine.ts';
import { mulberry32 } from '../public/js/pieces.ts';

test('random games run to completion without corruption', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rng = mulberry32(seed * 7919);
    const g = new Game(seed);
    let steps = 0;
    while (!g.over && steps++ < 20000) {
      const r = rng();
      if (r < 0.2) g.move(rng() < 0.5 ? -1 : 1);
      else if (r < 0.3) g.rotate(rng() < 0.5 ? -1 : 1);
      else if (r < 0.38) g.hardDrop();
      else if (r < 0.45) g.softDrop();
      else if (r < 0.48) g.applyAttack(1 + Math.floor(rng() * 4));
      else g.update(16 + rng() * 50);

      // invariants
      if (!g.over) {
        for (const [x, y] of g.cellsAt(g.current)) {
          assert.ok(x >= 0 && x < COLS && y >= 0 && y < ROWS, `piece in bounds (seed ${seed})`);
          assert.ok(!g.board[y][x], `piece does not overlap stack (seed ${seed})`);
        }
      }
      assert.equal(g.board.length, ROWS);
      for (const row of g.board) assert.equal(row.length, COLS);
      assert.ok(g.score >= 0 && Number.isFinite(g.score));
      g.takeEvents();
    }
    assert.ok(g.over, `game ${seed} ended (random attacks pile the board up)`);
  }
});
