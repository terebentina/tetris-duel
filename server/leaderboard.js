// JSON-file backed leaderboard: wins, losses and total lines per player name.

import fs from 'node:fs';
import path from 'node:path';

export class Leaderboard {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of raw) {
        this.entries.set(e.name, {
          name: e.name,
          wins: e.wins | 0,
          losses: e.losses | 0,
          lines: e.lines | 0,
        });
      }
    } catch {
      // missing or corrupt file -> start fresh
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  record(name, { win, lines = 0 }) {
    const e = this.entries.get(name) || { name, wins: 0, losses: 0, lines: 0 };
    if (win) e.wins++;
    else e.losses++;
    e.lines += lines;
    this.entries.set(name, e);
    this.save();
  }

  top(n = 20) {
    return [...this.entries.values()]
      .sort((a, b) => b.wins - a.wins || b.lines - a.lines || a.name.localeCompare(b.name))
      .slice(0, n);
  }
}
