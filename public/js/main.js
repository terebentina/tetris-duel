// App shell: menu / lobby / game screens, input handling, the game loop
// and the glue between the engine, renderer and network layer.

import { Game } from './engine.js';
import { Renderer, drawPreview } from './render.js';
import { Net } from './net.js';

const $ = (sel) => document.querySelector(sel);

const screens = {
  menu: $('#screen-menu'),
  lobby: $('#screen-lobby'),
  game: $('#screen-game'),
};

function show(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name);
  }
}

const net = new Net();
let game = null;
let renderer = null;
let oppRenderer = null;
let oppSnapshot = null;
let playerName = localStorage.getItem('tetris.name') || '';
let roomCode = null;
let inGame = false;
let lastStateSync = 0;
let banner = { text: '', t: 0, color: '#fff' };

// ---------------------------------------------------------------------
// Menu + leaderboard

$('#name-input').value = playerName;

async function refreshLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const entries = await res.json();
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
        td.textContent = v;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
  } catch {
    /* leaderboard is non-critical */
  }
}

function requireName() {
  const name = $('#name-input').value.trim();
  if (!name) {
    setMenuError('Enter your name first');
    $('#name-input').focus();
    return null;
  }
  playerName = name;
  localStorage.setItem('tetris.name', name);
  return name;
}

function setMenuError(text) {
  $('#menu-error').textContent = text;
}

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
  const code = $('#join-code').value.trim().toUpperCase();
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
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

// ---------------------------------------------------------------------
// Lobby

function enterLobby({ code, opponent }) {
  roomCode = code;
  $('#lobby-code').textContent = code;
  $('#lobby-you').textContent = playerName;
  setLobbyOpponent(opponent || null);
  $('#btn-ready').disabled = false;
  $('#btn-ready').textContent = 'Ready';
  $('#lobby-status').textContent = opponent
    ? 'Press Ready when you are set!'
    : 'Share this code with your friend…';
  show('lobby');
}

function setLobbyOpponent(name) {
  $('#lobby-opponent').textContent = name || 'waiting…';
  $('#lobby-opponent').classList.toggle('muted', !name);
}

$('#btn-ready').addEventListener('click', () => {
  net.send({ type: 'ready' });
  $('#btn-ready').disabled = true;
  $('#btn-ready').textContent = 'Waiting for opponent…';
});

$('#btn-lobby-back').addEventListener('click', () => {
  net.send({ type: 'leave' });
  backToMenu();
});

$('#btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $('#btn-copy-code').textContent = 'Copied!';
    setTimeout(() => ($('#btn-copy-code').textContent = 'Copy'), 1200);
  } catch {
    /* clipboard unavailable, code is visible anyway */
  }
});

function backToMenu() {
  inGame = false;
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
net.on('start', (msg) => startGame(msg));
net.on('opponent_state', (msg) => {
  oppSnapshot = msg.state;
  $('#opp-score').textContent = msg.state.score;
  $('#opp-lines').textContent = msg.state.lines;
});
net.on('attack', (msg) => {
  if (!game || game.over) return;
  game.applyAttack(msg.count);
});
net.on('end', (msg) => endGame(msg));
net.on('opponent_left', () => {
  if (!inGame) {
    setLobbyOpponent(null);
    $('#btn-ready').disabled = false;
    $('#btn-ready').textContent = 'Ready';
    $('#lobby-status').textContent = 'Opponent left. Share the code again…';
  }
});
net.on('_close', () => {
  if (inGame || screens.lobby.classList.contains('active')) {
    backToMenu();
    setMenuError('Connection lost');
  }
});

// ---------------------------------------------------------------------
// Game

const ATTACK_NAMES = {
  1: 'CURSED PIECE!',
  2: 'WIND STORM!',
  3: 'SPIN CHAOS!',
  4: 'TETRIS FURY!!!',
};

function startGame({ seed, opponent }) {
  game = new Game(seed);
  inGame = true;
  oppSnapshot = null;
  lastStateSync = 0;
  banner = { text: '', t: 0 };
  $('#you-name').textContent = playerName;
  $('#opp-name').textContent = opponent;
  $('#opp-score').textContent = '0';
  $('#opp-lines').textContent = '0';
  $('#gameover-overlay').classList.remove('visible');
  if (!renderer) {
    renderer = new Renderer($('#board'), { cell: 28 });
    oppRenderer = new Renderer($('#opp-board'), { cell: 13 });
  }
  show('game');
  countdown(3);
}

let countdownT = 0;
function countdown(n) {
  countdownT = n * 1000;
}

function endGame(msg) {
  inGame = false;
  $('#gameover-title').textContent = msg.youWin ? 'YOU WIN! 🏆' : 'YOU LOSE';
  $('#gameover-title').className = msg.youWin ? 'win' : 'lose';
  $('#gameover-sub').textContent = msg.forfeit
    ? 'Your opponent left the game.'
    : msg.youWin
      ? `${$('#opp-name').textContent} topped out!`
      : 'You ran out of space.';
  $('#btn-rematch').disabled = false;
  $('#btn-rematch').textContent = 'Rematch';
  $('#gameover-overlay').classList.add('visible');
  refreshLeaderboard();
}

$('#btn-rematch').addEventListener('click', () => {
  net.send({ type: 'ready' });
  $('#btn-rematch').disabled = true;
  $('#btn-rematch').textContent = 'Waiting for opponent…';
});

$('#btn-exit').addEventListener('click', () => {
  net.send({ type: 'leave' });
  backToMenu();
});

// ---------------------------------------------------------------------
// Input

const keys = { left: false, right: false, down: false };
const DAS = 170; // ms before auto-repeat
const ARR = 40; // ms between repeats
let dasTimer = 0;
let dasDir = 0;

function playing() {
  return inGame && game && !game.over && countdownT <= 0;
}

document.addEventListener('keydown', (e) => {
  if (!inGame || e.repeat) return;
  switch (e.code) {
    case 'ArrowLeft':
      keys.left = true;
      dasDir = -1;
      dasTimer = -DAS;
      if (playing()) game.move(-1);
      break;
    case 'ArrowRight':
      keys.right = true;
      dasDir = 1;
      dasTimer = -DAS;
      if (playing()) game.move(1);
      break;
    case 'ArrowDown':
      keys.down = true;
      if (game) game.softDropping = true;
      break;
    case 'ArrowUp':
    case 'KeyX':
      if (playing()) game.rotate(1);
      break;
    case 'KeyZ':
      if (playing()) game.rotate(-1);
      break;
    case 'Space':
      e.preventDefault();
      if (playing()) game.hardDrop();
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

function updateHud() {
  $('#you-score').textContent = game.score;
  $('#you-lines').textContent = game.lines;
  $('#you-level').textContent = game.level;

  // next queue (show skulls while cursed pieces are incoming)
  const previews = document.querySelectorAll('.next-piece');
  previews.forEach((c, i) => {
    if (i < game.hardPieces) drawPreview(c, null, { skull: true });
    else drawPreview(c, game.queue[i - game.hardPieces]);
  });

  // active effect badges
  const fx = [];
  if (game.hardPieces > 0) fx.push(`☠ cursed ×${game.hardPieces}`);
  if (game.windPieces > 0)
    fx.push(`${game.windDir > 0 ? '💨→' : '←💨'} wind ×${game.windPieces}`);
  if (game.spinPieces > 0) fx.push(`🌀 spin ×${game.spinPieces}`);
  $('#effects').innerHTML = fx.length
    ? fx.map((f) => `<span class="fx">${f}</span>`).join('')
    : '<span class="fx none">no curses</span>';

  renderer.setWind(game.windPieces > 0, game.windDir);
  renderer.setSpin(game.spinPieces > 0);
}

// ---------------------------------------------------------------------
// Main loop

let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(50, now - lastTime);
  lastTime = now;

  if (inGame && game) {
    if (countdownT > 0) {
      countdownT -= dt;
    } else if (!game.over) {
      // held-key auto repeat
      if (dasDir !== 0 && playing()) {
        dasTimer += dt;
        while (dasTimer >= ARR) {
          dasTimer -= ARR;
          game.move(dasDir);
        }
      }
      game.update(dt);
    }

    // consume engine events
    for (const ev of game.takeEvents()) {
      switch (ev.type) {
        case 'clear':
          renderer.lineClear(ev.rows, ev.count);
          net.send({ type: 'clear', count: ev.count });
          showBanner(
            ev.count >= 4 ? 'TETRIS!' : `${ev.count} LINE${ev.count > 1 ? 'S' : ''}!`,
            '#19d24b'
          );
          break;
        case 'attack':
          renderer.attackHit(ev.n);
          showBanner(ATTACK_NAMES[ev.n] || 'ATTACK!', '#ff3355');
          break;
        case 'lock':
          renderer.lockThud();
          break;
        case 'gameover':
          net.send({ type: 'gameover' });
          break;
      }
    }

    updateHud();
    renderer.update(dt);
    renderer.render(game, { isOver: game.over });
    oppRenderer.update(dt);
    oppRenderer.renderSnapshot(oppSnapshot);

    drawOverlays(dt);

    // throttled board sync to the opponent
    lastStateSync += dt;
    if (lastStateSync >= 120 && !game.over) {
      lastStateSync = 0;
      net.send({ type: 'state', state: game.snapshot() });
    }
  }

  requestAnimationFrame(loop);
}

function showBanner(text, color) {
  banner = { text, t: 1.4, color };
}

function drawOverlays(dt) {
  const ctx = renderer.ctx;
  const w = renderer.canvas.width;
  const h = renderer.canvas.height;

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
window.__tetris = {
  get game() {
    return game;
  },
  get inGame() {
    return inGame;
  },
  get countdownT() {
    return countdownT;
  },
};

refreshLeaderboard();
show('menu');
requestAnimationFrame(loop);
