// Canvas rendering: boards, pieces, ghost, next queue and all the
// juice — particles, shockwaves, sweep beams, wind streaks, fog,
// line flashes, score popups and screen shake.

import { COLORS, PIECES } from './pieces.ts';
import type { PieceType } from './pieces.ts';
import { COLS, ROWS, HIDDEN } from './engine.ts';
import type { BoardCell, Game, Snapshot } from './engine.ts';

const VISIBLE_ROWS = ROWS - HIDDEN;

const GARBAGE_COLOR = '#7d849c';
const FOG_SILHOUETTE = '#3c4258';

function cellColor(t: string): string {
  return (COLORS as Record<string, string>)[t] || GARBAGE_COLOR;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
  gravity?: number;
}

interface FlashRow {
  row: number;
  t: number;
}

interface WindGust {
  x: number;
  y: number;
  dir: number;
  speed: number;
  len: number;
}

// Expanding shockwave circle emitted by a cleared row.
interface Ring {
  x: number;
  y: number;
  r: number;
  v: number;
  t: number;
  color: string;
}

// Pair of bright bars sweeping outwards from the centre of a cleared row.
interface Beam {
  row: number;
  t: number;
}

// Floating text ("+800", "COMBO ×3!") rising from the board centre.
interface Popup {
  text: string;
  x: number;
  y: number;
  t: number;
  color: string;
  size: number;
}

// Drifting cloud puff for the fog curse.
interface FogBlob {
  x: number;
  y: number;
  r: number;
  vx: number;
}

const BEAM_LIFE = 0.45;
const RING_LIFE = 0.45;
const POPUP_LIFE = 1.2;

export class Renderer {
  canvas: HTMLCanvasElement;
  cell: number;
  ctx: CanvasRenderingContext2D;
  particles: Particle[] = [];
  flashRows: FlashRow[] = [];
  rings: Ring[] = [];
  beams: Beam[] = [];
  popups: Popup[] = [];
  flash = 0; // full-canvas flash (tetris)
  shake = 0;
  windGusts: WindGust[] = [];
  windDir = 0;
  spinning = false;
  fogged = false;
  fogBlobs: FogBlob[] = [];
  flipped = false;
  time = 0;

  constructor(canvas: HTMLCanvasElement, { cell = 28 }: { cell?: number } = {}) {
    this.canvas = canvas;
    this.cell = cell;
    canvas.width = COLS * cell;
    canvas.height = VISIBLE_ROWS * cell;
    this.ctx = canvas.getContext('2d')!;
  }

  // ---- effect triggers -------------------------------------------------

  lineClear(rows: number[], count: number, colors: BoardCell[][] = []): void {
    rows.forEach((row, i) => {
      const cy = (row - HIDDEN + 0.5) * this.cell;
      this.flashRows.push({ row, t: 0.35 });
      this.beams.push({ row, t: BEAM_LIFE });
      this.rings.push({
        x: this.canvas.width / 2,
        y: cy,
        r: this.cell,
        v: 500 + count * 130,
        t: RING_LIFE,
        color: count >= 4 ? '#ffd500' : '#8ce0ff',
      });
      // each cleared cell shatters into shards of its own colour
      for (let x = 0; x < COLS; x++) {
        const color = colors[i]?.[x] ? cellColor(colors[i][x]) : '#ffffff';
        for (let k = 0; k < 3; k++) {
          this.particles.push({
            x: (x + 0.5) * this.cell,
            y: cy,
            vx: (Math.random() - 0.5) * 380,
            vy: (Math.random() - 0.85) * 300,
            life: 0.5 + Math.random() * 0.5,
            color,
            size: 2 + Math.random() * 4,
          });
        }
      }
    });
    if (count >= 2) this.shake = Math.min(14, count * 3.5);
    if (count >= 4) {
      // a tetris gets the full fireworks: screen flash + gold confetti
      this.flash = 0.5;
      for (let i = 0; i < 90; i++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = 120 + Math.random() * 340;
        this.particles.push({
          x: this.canvas.width / 2,
          y: this.canvas.height / 2,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed - 80,
          life: 0.7 + Math.random() * 0.7,
          color: Math.random() < 0.6 ? '#ffd500' : '#ffffff',
          size: 2 + Math.random() * 3,
        });
      }
    }
  }

  scorePopup(text: string, color: string, { size = 26 }: { size?: number } = {}): void {
    this.popups.push({
      text,
      x: this.canvas.width / 2,
      y: this.canvas.height * 0.45 + this.popups.length * 26,
      t: POPUP_LIFE,
      color,
      size,
    });
  }

  garbageHit(n: number): void {
    this.shake = Math.max(this.shake, 8);
    for (let i = 0; i < 50 * n; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: this.canvas.height - Math.random() * (n + 1) * this.cell,
        vx: (Math.random() - 0.5) * 120,
        vy: -(60 + Math.random() * 220),
        life: 0.4 + Math.random() * 0.5,
        color: Math.random() < 0.5 ? GARBAGE_COLOR : '#4a4f63',
        size: 2 + Math.random() * 3,
        gravity: 160,
      });
    }
  }

  attackHit(n: number): void {
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

  setWind(active: boolean, dir: number): void {
    this.windDir = active ? dir : 0;
  }

  setSpin(active: boolean): void {
    this.spinning = active;
  }

  setFog(active: boolean): void {
    if (active && !this.fogged) {
      this.fogBlobs = Array.from({ length: 10 }, () => ({
        x: Math.random() * this.canvas.width,
        y: this.canvas.height * (0.3 + Math.random() * 0.7),
        r: 30 + Math.random() * 50,
        vx: (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 18),
      }));
    }
    this.fogged = active;
  }

  setFlip(active: boolean): void {
    this.flipped = active;
  }

  lockThud(): void {
    this.shake = Math.max(this.shake, 1.5);
  }

  // ---- frame -----------------------------------------------------------

  update(dt: number): void {
    const s = dt / 1000;
    this.time += s;
    this.particles = this.particles.filter((p) => (p.life -= s) > 0);
    for (const p of this.particles) {
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vy += (p.gravity ?? 420) * s;
    }
    this.flashRows = this.flashRows.filter((f) => (f.t -= s) > 0);
    this.rings = this.rings.filter((r) => (r.t -= s) > 0);
    for (const r of this.rings) r.r += r.v * s;
    this.beams = this.beams.filter((b) => (b.t -= s) > 0);
    this.popups = this.popups.filter((p) => (p.t -= s) > 0);
    for (const p of this.popups) p.y -= 36 * s;
    this.flash = Math.max(0, this.flash - 1.6 * s);
    this.shake = Math.max(0, this.shake - dt * 0.035);

    if (this.fogged) {
      for (const b of this.fogBlobs) {
        b.x += b.vx * s;
        if (b.x < -b.r) b.x = this.canvas.width + b.r;
        if (b.x > this.canvas.width + b.r) b.x = -b.r;
      }
    }

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

  drawCell(
    x: number,
    y: number,
    color: string,
    { ghost = false, alpha = 1 }: { ghost?: boolean; alpha?: number } = {}
  ): void {
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

  render(game: Game, { isOver = false }: { isOver?: boolean } = {}): void {
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

    // settled board (fog turns the stack into murky silhouettes)
    for (let y = HIDDEN; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = game.board[y][x];
        if (t) this.drawCell(x, y, this.fogged ? FOG_SILHOUETTE : cellColor(t));
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

    // fog clouds over the (silhouetted) stack
    if (this.fogged) {
      ctx.save();
      for (const b of this.fogBlobs) {
        const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        grad.addColorStop(0, 'rgba(170,180,210,0.28)');
        grad.addColorStop(1, 'rgba(170,180,210,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // line clear flashes
    for (const f of this.flashRows) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, f.t * 3)})`;
      ctx.fillRect(0, (f.row - HIDDEN) * this.cell, w, this.cell);
    }

    // sweep beams racing outwards along cleared rows
    for (const b of this.beams) {
      const prog = 1 - b.t / BEAM_LIFE;
      const y = (b.row - HIDDEN) * this.cell;
      const off = prog * w * 0.55;
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (b.t / BEAM_LIFE)})`;
      ctx.fillRect(w / 2 + off - 7, y, 14, this.cell);
      ctx.fillRect(w / 2 - off - 7, y, 14, this.cell);
    }

    // shockwave rings
    for (const r of this.rings) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, r.t / RING_LIFE) * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
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

    // flip curse: pulsing magenta vignette + reversed-arrows marker
    if (this.flipped) {
      const a = 0.3 + 0.18 * Math.sin(this.time * 5);
      ctx.save();
      ctx.strokeStyle = `rgba(181,23,232,${a})`;
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, w - 6, h - 6);
      ctx.fillStyle = `rgba(225,160,255,${a + 0.35})`;
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('→ ⇄ ←', w / 2, h - 16);
      ctx.restore();
    }

    // floating score / combo popups
    for (const p of this.popups) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p.t / POPUP_LIFE) * 2);
      ctx.fillStyle = p.color;
      ctx.font = `bold ${p.size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 6;
      ctx.fillText(p.text, p.x, p.y);
      ctx.restore();
    }

    // full-canvas flash (tetris!)
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,250,210,${this.flash})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (isOver) {
      ctx.fillStyle = 'rgba(5,6,12,0.7)';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // Render an opponent snapshot ({rows, current}) sent over the network.
  renderSnapshot(snap: Snapshot | null): void {
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
        if (t !== '.') this.drawCell(x, y, cellColor(t));
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
export function drawPreview(
  canvas: HTMLCanvasElement,
  type: PieceType | null | undefined,
  { skull = false }: { skull?: boolean } = {}
): void {
  const ctx = canvas.getContext('2d')!;
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
