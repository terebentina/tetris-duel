import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Leaderboard } from '../server/leaderboard.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')), 'leaderboard.json');
}

test('records wins, losses and lines', () => {
  const lb = new Leaderboard(tmpFile());
  lb.record('Alice', { win: true, lines: 10 });
  lb.record('Bob', { win: false, lines: 4 });
  lb.record('Alice', { win: true, lines: 7 });
  const top = lb.top();
  assert.equal(top[0].name, 'Alice');
  assert.equal(top[0].wins, 2);
  assert.equal(top[0].lines, 17);
  assert.equal(top[1].name, 'Bob');
  assert.equal(top[1].losses, 1);
});

test('persists to disk and reloads', () => {
  const file = tmpFile();
  const lb = new Leaderboard(file);
  lb.record('Dan', { win: true, lines: 12 });
  const lb2 = new Leaderboard(file);
  assert.equal(lb2.top()[0].name, 'Dan');
  assert.equal(lb2.top()[0].wins, 1);
});

test('sorts by wins, then lines', () => {
  const lb = new Leaderboard(tmpFile());
  lb.record('A', { win: true, lines: 1 });
  lb.record('B', { win: true, lines: 9 });
  lb.record('C', { win: false, lines: 100 });
  const top = lb.top();
  assert.deepEqual(top.map((e) => e.name), ['B', 'A', 'C']);
});

test('top(n) limits results', () => {
  const lb = new Leaderboard(tmpFile());
  for (let i = 0; i < 30; i++) lb.record(`P${i}`, { win: true, lines: i });
  assert.equal(lb.top(20).length, 20);
});

test('survives a missing or corrupt file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const lb = new Leaderboard(file);
  assert.deepEqual(lb.top(), []);
  lb.record('X', { win: true });
  assert.equal(new Leaderboard(file).top().length, 1);
});
