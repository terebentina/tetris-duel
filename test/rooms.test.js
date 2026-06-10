import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, sanitizeName } from '../server/rooms.js';

function fakeClient() {
  const c = {
    sent: [],
    send(obj) {
      c.sent.push(obj);
    },
    last(type) {
      return [...c.sent].reverse().find((m) => m.type === type);
    },
    name: null,
    room: null,
    ready: false,
  };
  return c;
}

function fakeLeaderboard() {
  return {
    records: [],
    record(name, result) {
      this.records.push({ name, ...result });
    },
  };
}

function setupMatch() {
  const lb = fakeLeaderboard();
  const mgr = new RoomManager(lb);
  const a = fakeClient();
  const b = fakeClient();
  mgr.handleMessage(a, { type: 'create', name: 'Alice' });
  const code = a.last('created').code;
  mgr.handleMessage(b, { type: 'join', code, name: 'Bob' });
  return { mgr, lb, a, b, code };
}

test('sanitizeName trims, strips junk and enforces length', () => {
  assert.equal(sanitizeName('  Dan  '), 'Dan');
  assert.equal(sanitizeName('<script>x</script>'), 'scriptxscript');
  assert.equal(sanitizeName('a'.repeat(40)).length, 16);
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(42), null);
});

test('create returns a 4-char room code', () => {
  const mgr = new RoomManager(fakeLeaderboard());
  const c = fakeClient();
  mgr.handleMessage(c, { type: 'create', name: 'Alice' });
  const msg = c.last('created');
  assert.ok(msg);
  assert.match(msg.code, /^[A-Z2-9]{4}$/);
});

test('join notifies both players', () => {
  const { a, b, code } = setupMatch();
  assert.equal(b.last('joined').opponent, 'Alice');
  assert.equal(b.last('joined').code, code);
  assert.equal(a.last('opponent_joined').opponent, 'Bob');
});

test('joining an unknown room errors', () => {
  const mgr = new RoomManager(fakeLeaderboard());
  const c = fakeClient();
  mgr.handleMessage(c, { type: 'join', code: 'XXXX', name: 'Bob' });
  assert.equal(c.last('error').error, 'room not found');
});

test('a third player cannot join a full room', () => {
  const { mgr, code } = setupMatch();
  const c = fakeClient();
  mgr.handleMessage(c, { type: 'join', code, name: 'Carl' });
  assert.equal(c.last('error').error, 'room is full');
});

test('game starts with a shared seed when both players are ready', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  assert.ok(!a.last('start'), 'one ready is not enough');
  assert.ok(b.last('opponent_ready'));
  mgr.handleMessage(b, { type: 'ready' });
  const sa = a.last('start');
  const sb = b.last('start');
  assert.ok(sa && sb);
  assert.equal(sa.seed, sb.seed);
  assert.equal(sa.opponent, 'Bob');
  assert.equal(sb.opponent, 'Alice');
});

test('state messages relay to the opponent only', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleMessage(a, { type: 'state', state: { score: 42 } });
  assert.equal(b.last('opponent_state').state.score, 42);
  assert.ok(!a.last('opponent_state'));
});

test('line clears become attacks on the opponent, clamped to 4', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleMessage(a, { type: 'clear', count: 2 });
  assert.equal(b.last('attack').count, 2);
  mgr.handleMessage(a, { type: 'clear', count: 99 });
  assert.equal(b.last('attack').count, 4);
});

test('gameover ends the match, opponent wins, leaderboard records both', () => {
  const { mgr, lb, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleMessage(a, { type: 'clear', count: 3 });
  mgr.handleMessage(a, { type: 'gameover' }); // Alice tops out
  assert.equal(a.last('end').youWin, false);
  assert.equal(b.last('end').youWin, true);
  assert.equal(b.last('end').winner, 'Bob');
  const bob = lb.records.find((r) => r.name === 'Bob');
  const alice = lb.records.find((r) => r.name === 'Alice');
  assert.equal(bob.win, true);
  assert.equal(alice.win, false);
  assert.equal(alice.lines, 3);
});

test('rematch: both ready again starts a fresh game', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleMessage(a, { type: 'gameover' });
  a.sent = [];
  b.sent = [];
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  assert.ok(a.last('start'));
  assert.ok(b.last('start'));
});

test('disconnect mid-game forfeits to the opponent', () => {
  const { mgr, lb, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleDisconnect(a);
  const end = b.last('end');
  assert.equal(end.youWin, true);
  assert.equal(end.forfeit, true);
  assert.ok(lb.records.find((r) => r.name === 'Bob' && r.win));
});

test('disconnect in lobby notifies opponent without ending a game', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleDisconnect(b);
  assert.ok(a.last('opponent_left'));
  assert.ok(!a.last('end'));
});

test('empty rooms are deleted', () => {
  const { mgr, a, b, code } = setupMatch();
  mgr.handleDisconnect(a);
  mgr.handleDisconnect(b);
  assert.equal(mgr.rooms.has(code), false);
});

test('attacks after game end are not relayed', () => {
  const { mgr, a, b } = setupMatch();
  mgr.handleMessage(a, { type: 'ready' });
  mgr.handleMessage(b, { type: 'ready' });
  mgr.handleMessage(a, { type: 'gameover' });
  b.sent = [];
  mgr.handleMessage(a, { type: 'clear', count: 2 });
  assert.ok(!b.last('attack'));
});
