// End-to-end test: boots the real HTTP+WebSocket server, connects two
// real WebSocket clients, plays a full match (create/join/ready/attack/
// gameover) and checks the leaderboard API afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server/server.ts';
import { Game } from '../public/js/engine.ts';
import type { ClientMessage, ServerMessage } from '../public/js/protocol.ts';

function wsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: ServerMessage[] = [];
  const waiters: { type: string; resolve: (msg: ServerMessage) => void }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    send: (obj: ClientMessage) => ws.send(JSON.stringify(obj)),
    open: () =>
      new Promise<void>((res, rej) => (ws.on('open', () => res()), ws.on('error', rej))),
    next<T extends ServerMessage['type']>(
      type: T,
      timeout = 3000
    ): Promise<Extract<ServerMessage, { type: T }>> {
      type Msg = Extract<ServerMessage, { type: T }>;
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0] as Msg);
      return new Promise<Msg>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeout);
        waiters.push({
          type,
          resolve: (m) => (clearTimeout(t), resolve(m as Msg)),
        });
      });
    },
    close: () => ws.close(),
  };
}

test('full match over real websockets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetris-e2e-'));
  const { server, leaderboard } = createServer({
    leaderboardFile: path.join(dir, 'leaderboard.json'),
  });
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as AddressInfo).port;
  t.after(() => server.close());

  // static files + health
  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /TETRIS/);
  // client TypeScript is served type-stripped as plain JavaScript
  const js = await fetch(`http://127.0.0.1:${port}/js/engine.ts`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  assert.doesNotMatch(await js.text(), /interface Snapshot/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  // path traversal is blocked
  const evil = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
  assert.notEqual(evil.status, 200);

  const alice = wsClient(port);
  const bob = wsClient(port);
  await alice.open();
  await bob.open();
  t.after(() => (alice.close(), bob.close()));

  // create + join
  alice.send({ type: 'create', name: 'Alice' });
  const created = await alice.next('created');
  bob.send({ type: 'join', code: created.code, name: 'Bob' });
  assert.equal((await bob.next('joined')).opponent, 'Alice');
  assert.equal((await alice.next('opponent_joined')).opponent, 'Bob');

  // ready up -> both get the same seed
  alice.send({ type: 'ready' });
  bob.send({ type: 'ready' });
  const [startA, startB] = await Promise.all([alice.next('start'), bob.next('start')]);
  assert.equal(startA.seed, startB.seed);

  // both clients run a real engine from the shared seed
  const gameA = new Game(startA.seed);
  const gameB = new Game(startB.seed);
  assert.equal(gameA.current.type, gameB.current.type);

  // Alice clears 3 lines -> Bob receives the attack and applies it
  alice.send({ type: 'clear', count: 3 });
  const attack = await bob.next('attack');
  assert.equal(attack.count, 3);
  gameB.applyAttack(attack.count);
  assert.equal(gameB.hardPieces, 3);
  assert.equal(gameB.windPieces, 4);
  assert.equal(gameB.spinPieces, 3);

  // board sync relays
  alice.send({ type: 'state', state: gameA.snapshot() });
  const oppState = await bob.next('opponent_state');
  assert.equal(oppState.state.rows.length, gameA.board.length);

  // Bob tops out -> Alice wins
  bob.send({ type: 'gameover' });
  const [endA, endB] = await Promise.all([alice.next('end'), bob.next('end')]);
  assert.equal(endA.youWin, true);
  assert.equal(endB.youWin, false);
  assert.equal(endA.winner, 'Alice');

  // leaderboard recorded and served over HTTP
  const lb = (await (
    await fetch(`http://127.0.0.1:${port}/api/leaderboard`)
  ).json()) as { name: string; wins: number; losses: number; lines: number }[];
  const aliceEntry = lb.find((e) => e.name === 'Alice')!;
  const bobEntry = lb.find((e) => e.name === 'Bob')!;
  assert.equal(aliceEntry.wins, 1);
  assert.equal(aliceEntry.lines, 3);
  assert.equal(bobEntry.losses, 1);
  assert.equal(leaderboard.top()[0].name, 'Alice');

  // rematch works over the wire
  alice.send({ type: 'ready' });
  bob.send({ type: 'ready' });
  const restart = await alice.next('start');
  assert.ok(Number.isInteger(restart.seed));
});

test('disconnect mid-game forfeits over the wire', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetris-e2e-'));
  const { server } = createServer({
    leaderboardFile: path.join(dir, 'leaderboard.json'),
  });
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as AddressInfo).port;
  t.after(() => server.close());

  const alice = wsClient(port);
  const bob = wsClient(port);
  await alice.open();
  await bob.open();
  t.after(() => bob.close());

  alice.send({ type: 'create', name: 'Alice' });
  const { code } = await alice.next('created');
  bob.send({ type: 'join', code, name: 'Bob' });
  await bob.next('joined');
  alice.send({ type: 'ready' });
  bob.send({ type: 'ready' });
  await Promise.all([alice.next('start'), bob.next('start')]);

  alice.close(); // rage quit
  const end = await bob.next('end');
  assert.equal(end.youWin, true);
  assert.equal(end.forfeit, true);
});
