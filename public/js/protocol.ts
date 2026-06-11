// Wire protocol shared by the server, the browser client and the tests.
// Types only — this module has no runtime code.

import type { Snapshot } from './engine.ts';

// Client -> server.
export type ClientMessage =
  | { type: 'create'; name: string }
  | { type: 'join'; code: string; name: string }
  | { type: 'ready' }
  | { type: 'state'; state: Snapshot }
  | { type: 'clear'; count: number }
  | { type: 'gameover' }
  | { type: 'leave' };

// Server -> client.
export type ServerMessage =
  | { type: 'created'; code: string; name: string }
  | { type: 'joined'; code: string; name: string; opponent: string }
  | { type: 'opponent_joined'; opponent: string }
  | { type: 'opponent_ready' }
  | { type: 'start'; seed: number; opponent: string }
  | { type: 'opponent_state'; state: Snapshot }
  | { type: 'attack'; count: number }
  | { type: 'end'; winner: string | null; youWin: boolean; forfeit?: boolean }
  | { type: 'opponent_left' }
  | { type: 'error'; error: string };

// Shape served by /api/leaderboard and persisted by the server.
export interface LeaderboardEntry {
  name: string;
  wins: number;
  losses: number;
  lines: number;
}
