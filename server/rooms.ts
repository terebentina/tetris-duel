// Room/matchmaking logic for 1v1 games. Transport-agnostic: a "client"
// is any object with `send(msg)` — the WebSocket wiring lives in server.ts
// and tests use fakes.

import type { ServerMessage } from '../public/js/protocol.ts';
import type { Snapshot } from '../public/js/engine.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const NAME_MAX = 16;

export interface Client {
  send(msg: ServerMessage): void;
  name: string | null;
  room: Room | null;
  ready: boolean;
}

export interface Room {
  code: string;
  players: Client[];
  started: boolean;
  lines: Map<Client, number>; // client -> lines cleared this game
}

// The subset of Leaderboard the room manager needs (tests use fakes).
export interface LeaderboardLike {
  record(name: string, result: { win: boolean; lines?: number }): void;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function sanitizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[^\w \-.]/g, '').trim().slice(0, NAME_MAX);
  return clean.length > 0 ? clean : null;
}

export class RoomManager {
  leaderboard: LeaderboardLike;
  rng: () => number;
  rooms = new Map<string, Room>();

  constructor(leaderboard: LeaderboardLike, { rng = Math.random }: { rng?: () => number } = {}) {
    this.leaderboard = leaderboard;
    this.rng = rng;
  }

  generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  handleMessage(client: Client, msg: unknown): void {
    if (!isRecord(msg) || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'create':
        return this.create(client, msg);
      case 'join':
        return this.join(client, msg);
      case 'ready':
        return this.ready(client);
      case 'state':
        return this.relayState(client, msg);
      case 'clear':
        return this.relayClear(client, msg);
      case 'gameover':
        return this.gameOver(client);
      case 'leave':
        return this.handleDisconnect(client);
      default:
        client.send({ type: 'error', error: `unknown message type: ${msg.type}` });
    }
  }

  create(client: Client, msg: Record<string, unknown>): void {
    const name = sanitizeName(msg.name);
    if (!name) return client.send({ type: 'error', error: 'invalid name' });
    this.handleDisconnect(client); // leave any previous room
    client.name = name;
    const code = this.generateCode();
    const room: Room = {
      code,
      players: [client],
      started: false,
      lines: new Map(),
    };
    this.rooms.set(code, room);
    client.room = room;
    client.ready = false;
    client.send({ type: 'created', code, name });
  }

  join(client: Client, msg: Record<string, unknown>): void {
    const name = sanitizeName(msg.name);
    if (!name) return client.send({ type: 'error', error: 'invalid name' });
    const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return client.send({ type: 'error', error: 'room not found' });
    if (room.players.length >= 2) {
      return client.send({ type: 'error', error: 'room is full' });
    }
    this.handleDisconnect(client);
    client.name = name;
    client.room = room;
    client.ready = false;
    room.players.push(client);
    const host = room.players[0];
    client.send({ type: 'joined', code, name, opponent: host.name! });
    host.send({ type: 'opponent_joined', opponent: name });
  }

  opponentOf(client: Client): Client | null {
    const room = client.room;
    if (!room) return null;
    return room.players.find((p) => p !== client) || null;
  }

  ready(client: Client): void {
    const room = client.room;
    if (!room || room.started) return;
    client.ready = true;
    const opp = this.opponentOf(client);
    if (opp) opp.send({ type: 'opponent_ready' });
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      room.started = true;
      room.lines = new Map(room.players.map((p) => [p, 0]));
      const seed = Math.floor(this.rng() * 0xffffffff);
      for (const p of room.players) {
        p.ready = false;
        p.send({
          type: 'start',
          seed,
          opponent: this.opponentOf(p)!.name!,
        });
      }
    }
  }

  relayState(client: Client, msg: Record<string, unknown>): void {
    const room = client.room;
    const opp = this.opponentOf(client);
    if (!room || !opp || !room.started) return;
    // Pure relay: the snapshot comes straight from the other client.
    opp.send({ type: 'opponent_state', state: msg.state as Snapshot });
  }

  relayClear(client: Client, msg: Record<string, unknown>): void {
    const room = client.room;
    const opp = this.opponentOf(client);
    if (!room || !opp || !room.started) return;
    const count = Math.max(1, Math.min(4, Number(msg.count) | 0));
    room.lines.set(client, (room.lines.get(client) || 0) + count);
    opp.send({ type: 'attack', count });
  }

  // `client` topped out -> the opponent wins.
  gameOver(client: Client): void {
    const room = client.room;
    if (!room || !room.started) return;
    const opp = this.opponentOf(client);
    this.finishGame(room, opp, client);
  }

  finishGame(room: Room, winner: Client | null, loser: Client | null): void {
    room.started = false;
    if (this.leaderboard && winner && loser) {
      this.leaderboard.record(winner.name!, {
        win: true,
        lines: room.lines.get(winner) || 0,
      });
      this.leaderboard.record(loser.name!, {
        win: false,
        lines: room.lines.get(loser) || 0,
      });
    }
    for (const p of room.players) {
      p.ready = false;
      p.send({ type: 'end', winner: winner ? winner.name : null, youWin: p === winner });
    }
  }

  handleDisconnect(client: Client): void {
    const room = client.room;
    if (!room) return;
    const opp = this.opponentOf(client);
    room.players = room.players.filter((p) => p !== client);
    client.room = null;
    client.ready = false;
    if (room.started && opp) {
      // Forfeit: the remaining player wins.
      room.started = false;
      if (this.leaderboard) {
        this.leaderboard.record(opp.name!, { win: true, lines: room.lines.get(opp) || 0 });
        this.leaderboard.record(client.name!, {
          win: false,
          lines: room.lines.get(client) || 0,
        });
      }
      opp.send({ type: 'end', winner: opp.name, youWin: true, forfeit: true });
    } else if (opp) {
      opp.send({ type: 'opponent_left' });
    }
    if (room.players.length === 0) this.rooms.delete(room.code);
  }
}
