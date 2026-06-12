// App shell: menu / lobby / game screens, input handling, the game loop
// and the glue between the engine, renderer and network layer.

import { Game } from './engine.ts';
import type { Snapshot } from './engine.ts';
import { Renderer, drawPreview } from './render.ts';
import { Net } from './net.ts';
import type { LeaderboardEntry, ServerMessage } from './protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const screens = {
  menu: $('#screen-menu'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
};

type ScreenName = keyof typeof screens;

function show(name: ScreenName): void {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name);
  }
}

interface Banner {
  text: string;
  t: number;
  color: string;
}

const net = new Net();
let game: Game | null = null;
let renderer: Renderer | null = null;
let oppRenderer: Renderer | null = null;
let oppSnapshot: Snapshot | null = null;
let playerName = localStorage.getItem('tetris.name') || '';
let roomCode: string | null = null;
let inGame = false;
// Single player: no server involved, your own line clears curse you.
let solo = false;
let lastStateSync = 0;
let banner: Banner = { text: '', t: 0, color: '#fff' };

// ---------------------------------------------------------------------
// Menu + leaderboard

$<HTMLInputElement>('#name-input').value = playerName;

async function refreshLeaderboard(): Promise<void> {
  try {
    const res = await fetch('/api/leaderboard');
    const entries = (await res.json()) as LeaderboardEntry[];
    const tbody = $('#leaderboard tbody');
    tbody.innerHTML = '';
    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">No games played yet</td></tr>';
      return;
    }
    entries.forEach((e, i) => {
      const tr = document.createElement('tr');
      for (const v of [i + 1, e.name, e.wins, e.lines]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
  } catch {
    /* leaderboard is non-critical */
  }
}

function requireName(): string | null {
  const name = $<HTMLInputElement>('#name-input').value.trim();
  if (!name) {
    setMenuError('Enter your name first');
    $<HTMLInputElement>('#name-input').focus();
    return null;
  }
  playerName = name;
  localStorage.setItem('tetris.name', name);
  return name;
}

function setMenuError(text: string): void {
  $('#menu-error').textContent = text;
}

$('#btn-solo').addEventListener('click', () => {
  const name = $<HTMLInputElement>('#name-input').value.trim();
  if (name) {
    playerName = name;
    localStorage.setItem('tetris.name', name);
  } else {
    playerName = 'You';
  }
  setMenuError('');
  solo = true;
  startGame({ seed: Date.now() & 0xffffffff, opponent: playerName });
});

$('#btn-create').addEventListener('click', async () => {
  const name = requireName();
  if (!name) return;
  setMenuError('');
  try {
    await net.connect();
    net.send({ type: 'create', name });
  } catch {
    setMenuError('Could not connect to server');
  }
});

$('#btn-join').addEventListener('click', async () => {
  const name = requireName();
  if (!name) return;
  const code = $<HTMLInputElement>('#join-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    setMenuError('Enter the 4-letter room code');
    return;
  }
  setMenuError('');
  try {
    await net.connect();
    net.send({ type: 'join', code, name });
  } catch {
    setMenuError('Could not connect to server');
  }
});

$('#join-code').addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

// ---------------------------------------------------------------------
// Lobby

function enterLobby({ code, opponent }: { code: string; opponent: string | null }): void {
  roomCode = code;
  $('#lobby-code').textContent = code;
  $('#lobby-you').textContent = playerName;
  setLobbyOpponent(opponent || null);
  $<HTMLButtonElement>('#btn-ready').disabled = false;
  $('#btn-ready').textContent = 'Ready';
  $('#lobby-status').textContent = opponent
    ? 'Press Ready when you are set!'
    : 'Share this code with your friend…';
  show('lobby');
}

function setLobbyOpponent(name: string | null): void {
  $('#lobby-opponent').textContent = name || 'waiting…';
  $('#lobby-opponent').classList.toggle('muted', !name);
}

$('#btn-ready').addEventListener('click', () => {
  net.send({ type: 'ready' });
  $<HTMLButtonElement>('#btn-ready').disabled = true;
  $('#btn-ready').textContent = 'Waiting for opponent…';
});

$('#btn-lobby-back').addEventListener('click', () => {
  net.send({ type: 'leave' });
  backToMenu();
});

$('#btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode || '');
    $('#btn-copy-code').textContent = 'Copied!';
    setTimeout(() => ($('#btn-copy-code').textContent = 'Copy'), 1200);
  } catch {
    /* clipboard unavailable, code is visible anyway */
  }
});

function backToMenu(): void {
  inGame = false;
  solo = false;
  game = null;
  oppSnapshot = null;
  $('#gameover-overlay').classList.remove('visible');
  refreshLeaderboard();
  show('menu');
}

// ---------------------------------------------------------------------
// Network events

net.on('created', (msg) => enterLobby({ code: msg.code, opponent: null }));
net.on('joined', (msg) => enterLobby({ code: msg.code, opponent: msg.opponent }));
net.on('opponent_joined', (msg) => {
  setLobbyOpponent(msg.opponent);
  $('#lobby-status').textContent = 'Press Ready when you are set!';
});
net.on('opponent_ready', () => {
  $('#lobby-status').textContent = 'Opponent is ready!';
});
net.on('error', (msg) => setMenuError(msg.error));
net.on('start', (msg) => {
  solo = false;
  startGame(msg);
});
net.on('opponent_state', (msg) => {
  oppSnapshot = msg.state;
  $('#opp-score').textContent = String(msg.state.score);
  $('#opp-lines').textContent = String(msg.state.lines);
});
net.on('attack', (msg) => {
  if (!game || game.over) return;
  game.applyAttack(msg.count);
});
net.on('end', (msg) => endGame(msg));
net.on('opponent_left', () => {
  if (!inGame) {
    setLobbyOpponent(null);
    $<HTMLButtonElement>('#btn-ready').disabled = false;
    $('#btn-ready').textContent = 'Ready';
    $('#lobby-status').textContent = 'Opponent left. Share the code again…';
  }
});
net.onClose = () => {
  if (solo) return; // solo play doesn't use the connection
  if (inGame || screens.lobby.classList.contains('active')) {
    backToMenu();
    setMenuError('Connection lost');
  }
};

// ---------------------------------------------------------------------
// Game

const ATTACK_NAMES: Record<number, string> = {
  1: 'CURSED PIECE!',
  2: 'WIND STORM!',
  3: 'SPIN + FLIP CHAOS!',
  4: 'TETRIS FURY!!!',
};

function startGame({ seed, opponent }: { seed: number; opponent: string }): void {
  game = new Game(seed);
  inGame = true;
  oppSnapshot = null;
  lastStateSync = 0;
  banner = { text: '', t: 0, color: '#fff' };
  $('#you-name').textContent = playerName;
  $('#opp-name').textContent = opponent;
  $('#opp-score').textContent = '0';
  $('#opp-lines').textContent = '0';
  screens.game.classList.toggle('solo', solo);
  $('#gameover-overlay').classList.remove('visible');
  if (!renderer) {
    renderer = new Renderer($<HTMLCanvasElement>('#board'), { cell: 28 });
    oppRenderer = new Renderer($<HTMLCanvasElement>('#opp-board'), { cell: 13 });
  }
  show('game');
  countdown(3);
}

let countdownT = 0;
function countdown(n: number): void {
  countdownT = n * 1000;
}

function endSoloGame(g: Game): void {
  inGame = false;
  $('#gameover-title').textContent = 'GAME OVER';
  $('#gameover-title').className = 'lose';
  $('#gameover-sub').textContent = `Bested by yourself — ${g.score} points · ${g.lines} lines.`;
  $<HTMLButtonElement>('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = 'Play again';
  $('#gameover-overlay').classList.add('visible');
}

function endGame(msg: Extract<ServerMessage, { type: 'end' }>): void {
  inGame = false;
  $('#gameover-title').textContent = msg.youWin ? 'YOU WIN! 🏆' : 'YOU LOSE';
  $('#gameover-title').className = msg.youWin ? 'win' : 'lose';
  $('#gameover-sub').textContent = msg.forfeit
    ? 'Your opponent left the game.'
    : msg.youWin
      ? `${$('#opp-name').textContent} topped out!`
      : 'You ran out of space.';
  $<HTMLButtonElement>('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = 'Rematch';
  $('#gameover-overlay').classList.add('visible');
  refreshLeaderboard();
}

$('#btn-rematch').addEventListener('click', () => {
  if (solo) {
    startGame({ seed: Date.now() & 0xffffffff, opponent: playerName });
    return;
  }
  net.send({ type: 'ready' });
  $<HTMLButtonElement>('#btn-rematch').disabled = true;
  $('#btn-rematch').textContent = 'Waiting for opponent…';
});

$('#btn-exit').addEventListener('click', () => {
  if (!solo) net.send({ type: 'leave' });
  backToMenu();
});

// ---------------------------------------------------------------------
// Input

const keys = { left: false, right: false, down: false };
const DAS = 170; // ms before auto-repeat
const ARR = 40; // ms between repeats
let dasTimer = 0;
let dasDir = 0;

// The game, but only while it is actually playable (started, not over,
// countdown finished) — null otherwise.
function playing(): Game | null {
  return inGame && game && !game.over && countdownT <= 0 ? game : null;
}

document.addEventListener('keydown', (e) => {
  if (!inGame || e.repeat) return;
  switch (e.code) {
    case 'ArrowLeft':
      keys.left = true;
      dasDir = -1;
      dasTimer = -DAS;
      playing()?.move(-1);
      break;
    case 'ArrowRight':
      keys.right = true;
      dasDir = 1;
      dasTimer = -DAS;
      playing()?.move(1);
      break;
    case 'ArrowDown':
      keys.down = true;
      if (game) game.softDropping = true;
      break;
    case 'ArrowUp':
    case 'KeyX':
      playing()?.rotate(1);
      break;
    case 'KeyZ':
      playing()?.rotate(-1);
      break;
    case 'Space':
      e.preventDefault();
      playing()?.hardDrop();
      break;
  }
});

document.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowLeft':
      keys.left = false;
      if (dasDir === -1) dasDir = keys.right ? 1 : 0;
      break;
    case 'ArrowRight':
      keys.right = false;
      if (dasDir === 1) dasDir = keys.left ? -1 : 0;
      break;
    case 'ArrowDown':
      keys.down = false;
      if (game) game.softDropping = false;
      break;
  }
});

// ---------------------------------------------------------------------
// HUD

function updateHud(g: Game, r: Renderer): void {
  $('#you-score').textContent = String(g.score);
  $('#you-lines').textContent = String(g.lines);
  $('#you-level').textContent = String(g.level);

  // next queue (show skulls while cursed pieces are incoming)
  const previews = document.querySelectorAll<HTMLCanvasElement>('.next-piece');
  previews.forEach((c, i) => {
    if (i < g.hardPieces) drawPreview(c, null, { skull: true });
    else drawPreview(c, g.queue[i - g.hardPieces]);
  });

  // active effect badges
  const fx: string[] = [];
  if (g.hardPieces > 0) fx.push(`☠ cursed ×${g.hardPieces}`);
  if (g.windPieces > 0)
    fx.push(`${g.windDir > 0 ? '💨→' : '←💨'} wind ×${g.windPieces}`);
  if (g.spinPieces > 0) fx.push(`🌀 spin ×${g.spinPieces}`);
  if (g.flipPieces > 0) fx.push(`⇄ flipped ×${g.flipPieces}`);
  if (g.fogPieces > 0) fx.push(`🌫 fog ×${g.fogPieces}`);
  $('#effects').innerHTML = fx.length
    ? fx.map((f) => `<span class="fx">${f}</span>`).join('')
    : '<span class="fx none">no curses</span>';

  r.setWind(g.windPieces > 0, g.windDir);
  r.setSpin(g.spinPieces > 0);
  r.setFog(g.fogPieces > 0);
  r.setFlip(g.flipPieces > 0);
}

// ---------------------------------------------------------------------
// Main loop

let lastTime = performance.now();
function loop(now: number): void {
  const dt = Math.min(50, now - lastTime);
  lastTime = now;

  if (inGame && game && renderer && oppRenderer) {
    const g = game;
    if (countdownT > 0) {
      countdownT -= dt;
    } else if (!g.over) {
      // held-key auto repeat
      if (dasDir !== 0 && playing()) {
        dasTimer += dt;
        while (dasTimer >= ARR) {
          dasTimer -= ARR;
          g.move(dasDir);
        }
      }
      g.update(dt);
    }

    // consume engine events
    for (const ev of g.takeEvents()) {
      switch (ev.type) {
        case 'clear':
          renderer.lineClear(ev.rows, ev.count, ev.colors);
          renderer.scorePopup(`+${ev.points}`, ev.count >= 4 ? '#ffd500' : '#ffffff');
          if (ev.combo >= 2)
            renderer.scorePopup(`COMBO ×${ev.combo}!`, '#00e5ff', { size: 22 });
          // In solo play you are your own opponent: the curse you would
          // inflict on them lands on your board instead.
          if (solo) g.applyAttack(ev.count);
          else net.send({ type: 'clear', count: ev.count });
          showBanner(
            ev.count >= 4 ? 'TETRIS!' : `${ev.count} LINE${ev.count > 1 ? 'S' : ''}!`,
            ev.count >= 4 ? '#ffd500' : '#19d24b'
          );
          break;
        case 'attack':
          renderer.attackHit(ev.n);
          showBanner(ATTACK_NAMES[ev.n] || 'ATTACK!', '#ff3355');
          break;
        case 'garbage':
          renderer.garbageHit(ev.n);
          break;
        case 'lock':
          renderer.lockThud();
          break;
        case 'gameover':
          if (solo) endSoloGame(g);
          else net.send({ type: 'gameover' });
          break;
      }
    }

    updateHud(g, renderer);
    renderer.update(dt);
    renderer.render(g, { isOver: g.over });
    if (!solo) {
      oppRenderer.update(dt);
      oppRenderer.renderSnapshot(oppSnapshot);
    }

    drawOverlays(renderer, dt);

    // throttled board sync to the opponent
    lastStateSync += dt;
    if (!solo && lastStateSync >= 120 && !g.over) {
      lastStateSync = 0;
      net.send({ type: 'state', state: g.snapshot() });
    }
  }

  requestAnimationFrame(loop);
}

function showBanner(text: string, color: string): void {
  banner = { text, t: 1.4, color };
}

function drawOverlays(r: Renderer, dt: number): void {
  const ctx = r.ctx;
  const w = r.canvas.width;
  const h = r.canvas.height;

  if (countdownT > 0) {
    ctx.fillStyle = 'rgba(5,6,12,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.ceil(countdownT / 1000)), w / 2, h / 2);
  }

  if (banner.t > 0) {
    banner.t -= dt / 1000;
    const a = Math.min(1, banner.t * 2);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = banner.color;
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 8;
    ctx.fillText(banner.text, w / 2, h * 0.25);
    ctx.restore();
  }
}

// Debug/testing hook (used by the headless browser e2e test).
declare global {
  interface Window {
    __tetris: {
      readonly game: Game | null;
      readonly inGame: boolean;
      readonly solo: boolean;
      readonly countdownT: number;
    };
  }
}

window.__tetris = {
  get game() {
    return game;
  },
  get inGame() {
    return inGame;
  },
  get solo() {
    return solo;
  },
  get countdownT() {
    return countdownT;
  },
};

refreshLeaderboard();
show('menu');
requestAnimationFrame(loop);
