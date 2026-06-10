// Canvas rendering: boards, pieces, ghost, next queue and all the
// juice — particles, wind streaks, line flashes, screen shake.

import { COLORS, PIECES } from './pieces.js';
import { COLS, ROWS, HIDDEN } from './engine.js';

const VISIBLE_ROWS = ROWS - HIDDEN;

export class Renderer {
  constructor(canvas, { cell = 28 } = {}) {
    this.canvas = canvas;
    this.cell = cell;
    canvas.width = COLS * cell;
    canvas.height = VISIBLE_ROWS * cell;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.flashRows = []; // {row, t}
    this.shake = 0;
    this.windGusts = []; // {y, x, dir, speed}
    this.windDir = 0;
    this.spinning = false;
  }

  // ---- effect triggers -------------------------------------------------

  lineClear(rows, count) {
    for (const row of rows) {
      this.flashRows.push({ row, t: 0.35 });
      for (let i = 0; i < COLS * 2; i++) {
        this.particles.push({
          x: Math.random() * this.canvas.width,
          y: (row - HIDDEN + 0.5) * this.cell,
          vx: (Math.random() - 0.5) * 320,
          vy: (Math.random() - 0.8) * 260,
          life: 0.5 + Math.random() * 0.4,
          color: count >= 4 ? '#ffd500' : '#ffffff',
          size: 2 + Math.random() * 3,
        });
      }
    }
    if (count >= 2) this.shake = Math.min(10, count * 3);
  }

  attackHit(n) {
    this.shake = Math.min(14, 4 + n * 2.5);
    for (let i = 0; i < n * 18; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: -10,
        vx: (Math.random() - 0.5) * 80,
        vy: 120 + Math.random() * 220,
        life: 0.6 + Math.random() * 0.5,
        color: '#ff3355',
        size: 2 + Math.random() * 3,
      });
    }
  }

  setWind(active, dir) {
    this.windDir = active ? dir : 0;
  }

  setSpin(active) {
    this.spinning = active;
  }

  lockThud() {
    this.shake = Math.max(this.shake, 1.5);
  }

  // ---- frame -----------------------------------------------------------

  update(dt) {
    const s = dt / 1000;
    this.particles = this.particles.filter((p) => (p.life -= s) > 0);
    for (const p of this.particles) {
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vy += 420 * s;
    }
    this.flashRows = this.flashRows.filter((f) => (f.t -= s) > 0);
    this.shake = Math.max(0, this.shake - dt * 0.035);

    if (this.windDir !== 0) {
      if (Math.random() < 0.35) {
        this.windGusts.push({
          x: this.windDir > 0 ? -20 : this.canvas.width + 20,
          y: Math.random() * this.canvas.height,
          dir: this.windDir,
          speed: 260 + Math.random() * 280,
          len: 18 + Math.random() * 30,
        });
      }
    }
    this.windGusts = this.windGusts.filter(
      (g) => g.x > -60 && g.x < this.canvas.width + 60
    );
    for (const g of this.windGusts) g.x += g.dir * g.speed * s;
  }

  drawCell(x, y, color, { ghost = false, alpha = 1 } = {}) {
    const c = this.cell;
    const px = x * c;
    const py = (y - HIDDEN) * c;
    if (y < HIDDEN) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (ghost) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 2, py + 2, c - 4, c - 4);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(px + 1, py + 1, c - 2, c - 2);
      // bevel highlight
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(px + 1, py + 1, c - 2, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(px + 1, py + c - 5, c - 2, 4);
    }
    ctx.restore();
  }

  render(game, { isOver = false } = {}) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate(
        (Math.random() - 0.5) * this.shake,
        (Math.random() - 0.5) * this.shake
      );
    }
    // background
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0c0f1d');
    grad.addColorStop(1, '#141a30');
    ctx.fillStyle = grad;
    ctx.fillRect(-20, -20, w + 40, h + 40);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 1; x < COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * this.cell, 0);
      ctx.lineTo(x * this.cell, h);
      ctx.stroke();
    }
    for (let y = 1; y < VISIBLE_ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * this.cell);
      ctx.lineTo(w, y * this.cell);
      ctx.stroke();
    }

    // settled board
    for (let y = HIDDEN; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = game.board[y][x];
        if (t) this.drawCell(x, y, COLORS[t]);
      }
    }

    // ghost + current piece
    if (game.current && !game.over) {
      const gy = game.ghostY();
      for (const [cx, cy] of PIECES[game.current.type].rotations[game.current.rot]) {
        this.drawCell(game.current.x + cx, gy + cy, COLORS[game.current.type], {
          ghost: true,
          alpha: 0.35,
        });
      }
      for (const [cx, cy] of PIECES[game.current.type].rotations[game.current.rot]) {
        this.drawCell(game.current.x + cx, game.current.y + cy, COLORS[game.current.type]);
      }
    }

    // line clear flashes
    for (const f of this.flashRows) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, f.t * 3)})`;
      ctx.fillRect(0, (f.row - HIDDEN) * this.cell, w, this.cell);
    }

    // wind gusts
    if (this.windDir !== 0) {
      ctx.strokeStyle = 'rgba(140,200,255,0.5)';
      ctx.lineWidth = 2;
      for (const g of this.windGusts) {
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(g.x - g.dir * g.len, g.y);
        ctx.stroke();
      }
    }

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    if (isOver) {
      ctx.fillStyle = 'rgba(5,6,12,0.7)';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // Render an opponent snapshot ({rows, current}) sent over the network.
  renderSnapshot(snap) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#0c0f1d';
    ctx.fillRect(0, 0, w, h);
    if (!snap) return;
    for (let y = HIDDEN; y < ROWS; y++) {
      const row = snap.rows[y];
      if (!row) continue;
      for (let x = 0; x < COLS; x++) {
        const t = row[x];
        if (t !== '.') this.drawCell(x, y, COLORS[t] || '#888');
      }
    }
    if (snap.current) {
      const { type, rot, x, y } = snap.current;
      for (const [cx, cy] of PIECES[type].rotations[rot]) {
        this.drawCell(x + cx, y + cy, COLORS[type]);
      }
    }
    if (snap.over) {
      ctx.fillStyle = 'rgba(5,6,12,0.7)';
      ctx.fillRect(0, 0, w, h);
    }
  }
}

// Draw a single piece centered in a small preview canvas (next queue).
export function drawPreview(canvas, type, { skull = false } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (skull) {
    ctx.fillStyle = '#ff8ba0';
    ctx.font = `${canvas.height * 0.6}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☠', canvas.width / 2, canvas.height / 2 + 2);
    return;
  }
  if (!type) return;
  const cells = PIECES[type].rotations[0];
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const pw = Math.max(...xs) - minX + 1;
  const ph = Math.max(...ys) - minY + 1;
  const cell = Math.min(canvas.width / (pw + 1), canvas.height / (ph + 1));
  const ox = (canvas.width - pw * cell) / 2;
  const oy = (canvas.height - ph * cell) / 2;
  for (const [x, y] of cells) {
    ctx.fillStyle = COLORS[type];
    ctx.fillRect(ox + (x - minX) * cell + 1, oy + (y - minY) * cell + 1, cell - 2, cell - 2);
  }
}
