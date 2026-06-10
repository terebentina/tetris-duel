import test from 'node:test';
import assert from 'node:assert/strict';
import { PIECES, TYPES, SevenBag, mulberry32 } from '../public/js/pieces.js';

test('every piece has 4 rotations of 4 cells each', () => {
  for (const type of TYPES) {
    const { size, rotations } = PIECES[type];
    assert.equal(rotations.length, 4);
    for (const cells of rotations) {
      assert.equal(cells.length, 4, `${type} rotation must have 4 cells`);
      for (const [x, y] of cells) {
        assert.ok(x >= 0 && x < size && y >= 0 && y < size);
      }
    }
  }
});

test('O piece is rotation-invariant', () => {
  const r = PIECES.O.rotations;
  for (let i = 1; i < 4; i++) {
    assert.deepEqual(new Set(r[i].map(String)), new Set(r[0].map(String)));
  }
});

test('7-bag yields each piece exactly once per bag', () => {
  const bag = new SevenBag(42);
  for (let cycle = 0; cycle < 10; cycle++) {
    const drawn = new Set();
    for (let i = 0; i < 7; i++) drawn.add(bag.next());
    assert.equal(drawn.size, 7, 'each cycle of 7 contains all types');
  }
});

test('7-bag is deterministic for a given seed', () => {
  const a = new SevenBag(1234);
  const b = new SevenBag(1234);
  for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());
});

test('different seeds give different sequences', () => {
  const a = new SevenBag(1);
  const b = new SevenBag(2);
  const seqA = Array.from({ length: 21 }, () => a.next()).join('');
  const seqB = Array.from({ length: 21 }, () => b.next()).join('');
  assert.notEqual(seqA, seqB);
});

test('mulberry32 returns floats in [0,1) and is deterministic', () => {
  const r1 = mulberry32(99);
  const r2 = mulberry32(99);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, r2());
  }
});
