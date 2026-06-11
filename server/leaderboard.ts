// JSON-file backed leaderboard: wins, losses and total lines per player name.

import fs from 'node:fs';
import path from 'node:path';
import type { LeaderboardEntry } from '../public/js/protocol.ts';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class Leaderboard {
  file: string;
  entries = new Map<string, LeaderboardEntry>();

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  load(): void {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) return;
      for (const e of raw as unknown[]) {
        if (!isRecord(e) || typeof e.name !== 'string') continue;
        this.entries.set(e.name, {
          name: e.name,
          wins: Number(e.wins) | 0,
          losses: Number(e.losses) | 0,
          lines: Number(e.lines) | 0,
        });
      }
    } catch {
      // missing or corrupt file -> start fresh
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  record(name: string, { win, lines = 0 }: { win: boolean; lines?: number }): void {
    const e = this.entries.get(name) || { name, wins: 0, losses: 0, lines: 0 };
    if (win) e.wins++;
    else e.losses++;
    e.lines += lines;
    this.entries.set(name, e);
    this.save();
  }

  top(n = 20): LeaderboardEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.wins - a.wins || b.lines - a.lines || a.name.localeCompare(b.name))
      .slice(0, n);
  }
}
