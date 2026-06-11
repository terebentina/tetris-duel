// Full-stack browser test: two real Chromium pages play against each
// other through the real server — menu, lobby, countdown, attacks,
// game over and leaderboard. Skipped when Playwright/Chromium is not
// installed (run `npx playwright install chromium`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server/server.ts';
import type { PieceType } from '../public/js/pieces.ts';

const require = createRequire(import.meta.url);

// Minimal structural types for the bits of Playwright this test uses
// (Playwright is an optional global install, so its own types may be absent).
interface ConsoleMessage {
  type(): string;
  text(): string;
}

interface Keyboard {
  press(key: string): Promise<void>;
}

interface Page {
  on(event: 'pageerror', fn: (err: unknown) => void): void;
  on(event: 'console', fn: (msg: ConsoleMessage) => void): void;
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForFunction(
    fn: () => unknown,
    arg?: unknown,
    options?: { timeout?: number }
  ): Promise<unknown>;
  keyboard: Keyboard;
}

interface BrowserContext {
  newPage(): Promise<Page>;
}

interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<unknown>;
}

interface ChromiumLike {
  launch(): Promise<Browser>;
}

function loadChromium(): ChromiumLike | null {
  const candidates = ['playwright'];
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(path.join(globalRoot, 'playwright'));
  } catch {
    /* no npm */
  }
  for (const c of candidates) {
    try {
      return (require(c) as { chromium: ChromiumLike }).chromium;
    } catch {
      /* try next */
    }
  }
  return null;
}

const chromium = loadChromium();

test('two browsers play a full match', { skip: !chromium }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetris-browser-'));
  const { server } = createServer({
    leaderboardFile: path.join(dir, 'leaderboard.json'),
  });
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  let browser: Browser;
  try {
    browser = await chromium!.launch();
  } catch {
    t.skip('chromium not installed');
    return;
  }
  t.after(() => browser.close());

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors: string[] = [];
  for (const p of [pageA, pageB]) {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
  }

  // --- menu: Alice creates, Bob joins -------------------------------
  await pageA.goto(url);
  await pageA.fill('#name-input', 'Alice');
  await pageA.click('#btn-create');
  await pageA.waitForSelector('#screen-lobby.active');
  const code = (await pageA.textContent('#lobby-code'))!.trim();
  assert.match(code, /^[A-Z2-9]{4}$/);

  await pageB.goto(url);
  await pageB.fill('#name-input', 'Bob');
  await pageB.fill('#join-code', code);
  await pageB.click('#btn-join');
  await pageB.waitForSelector('#screen-lobby.active');
  assert.equal((await pageB.textContent('#lobby-opponent'))!.trim(), 'Alice');
  await pageA.waitForFunction(
    () => document.querySelector('#lobby-opponent')!.textContent === 'Bob'
  );

  // --- ready up, game starts after the countdown --------------------
  await pageA.click('#btn-ready');
  await pageB.click('#btn-ready');
  await pageA.waitForSelector('#screen-game.active');
  await pageB.waitForSelector('#screen-game.active');
  await pageA.waitForFunction(() => window.__tetris.countdownT <= 0, null, {
    timeout: 8000,
  });
  await pageB.waitForFunction(() => window.__tetris.countdownT <= 0);

  // same seed -> same first piece on both sides
  const typeA = await pageA.evaluate(() => window.__tetris.game!.current.type);
  const typeB = await pageB.evaluate(() => window.__tetris.game!.current.type);
  assert.equal(typeA, typeB);

  // --- gameplay: keyboard input works -------------------------------
  await pageA.keyboard.press('Space'); // hard drop
  const lockedCells = await pageA.evaluate(
    () => window.__tetris.game!.board.flat().filter(Boolean).length
  );
  assert.equal(lockedCells, 4, 'hard drop locked a piece');

  // --- Alice clears 3 lines -> Bob gets cursed ----------------------
  await pageA.evaluate(() => {
    const g = window.__tetris.game!;
    for (let y = 1; y <= 3; y++) {
      g.board[g.board.length - y] = new Array<PieceType | null>(10).fill('I');
    }
    g.clearLines(); // the game loop relays the 'clear' event to the server
  });
  await pageB.waitForFunction(() => window.__tetris.game!.hardPieces > 0, null, {
    timeout: 5000,
  });
  const fx = await pageB.evaluate(() => ({
    hard: window.__tetris.game!.hardPieces,
    wind: window.__tetris.game!.windPieces,
    spin: window.__tetris.game!.spinPieces,
    badges: document.querySelector('#effects')!.textContent ?? '',
  }));
  assert.ok(fx.hard >= 1, 'cursed pieces queued');
  assert.ok(fx.wind >= 1, 'wind active');
  assert.ok(fx.spin >= 1, 'spin active');
  assert.match(fx.badges, /cursed/);
  assert.match(fx.badges, /wind/);
  assert.match(fx.badges, /spin/);

  // opponent board sync reaches Alice
  await pageA.waitForFunction(
    () => document.querySelector('#opp-score') !== null,
    null,
    { timeout: 5000 }
  );

  // --- Bob tops out -> Alice wins, leaderboard updates ---------------
  await pageB.evaluate(() => {
    const g = window.__tetris.game!;
    for (let y = 0; y < g.board.length; y++) {
      g.board[y] = g.board[y].map((c, x) => (x === 0 ? null : 'I'));
    }
    g.hardDrop(); // locks high -> tops out -> loop sends gameover
  });
  await pageA.waitForSelector('#gameover-overlay.visible', { timeout: 5000 });
  await pageB.waitForSelector('#gameover-overlay.visible');
  assert.match((await pageA.textContent('#gameover-title'))!, /WIN/);
  assert.match((await pageB.textContent('#gameover-title'))!, /LOSE/);

  const lb = (await (await fetch(`${url}/api/leaderboard`)).json()) as {
    name: string;
    wins: number;
    losses: number;
  }[];
  assert.equal(lb.find((e) => e.name === 'Alice')!.wins, 1);
  assert.equal(lb.find((e) => e.name === 'Bob')!.losses, 1);

  // --- rematch -------------------------------------------------------
  await pageA.click('#btn-rematch');
  await pageB.click('#btn-rematch');
  await pageA.waitForFunction(
    () => !document.querySelector('#gameover-overlay')!.classList.contains('visible'),
    null,
    { timeout: 5000 }
  );

  assert.deepEqual(errors, [], 'no browser console errors');
});
