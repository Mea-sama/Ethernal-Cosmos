import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { Server } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@ethernal/shared';
import { initDatabase } from './db/database';
import { authRouter } from './auth/auth.router';
import { userDataRouter, playerDataRouter, leaderboardRouter } from './user-data/userdata.router';
import { registerSocketAuth, registerLobbyHandlers, registerIpcRouting } from './lobby/lobby.socket';
import { listGames } from './games/game.registry';

// Intern: Node.js lauscht nur auf localhost. Caddy übernimmt TLS extern auf :12346.
const PORT = parseInt(process.env.PORT ?? '12348', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();
const httpServer = createServer(app);

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(compression());
app.use(express.json());

// ─── Socket.io ──────────────────────────────────────────────────────────────

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  {
    cors: {
      origin: '*', // TODO: auf bekannte Origins einschränken, wenn HTTPS eingerichtet ist
      methods: ['GET', 'POST'],
    },
    // Schneller Heartbeat: Disconnect wird spätestens nach ~7s erkannt statt ~45s
    pingInterval: 2000,
    pingTimeout:  5000,
  }
);

// ─── Socket.io Auth + Lobby + IPC ─────────────────────────────────────────────────────────────

registerSocketAuth(io);
registerIpcRouting(io);
registerLobbyHandlers(io);

// ─── REST Routes ─────────────────────────────────────────────────────────────

// Statische Assets + Spiele-Clients + Docs (vor REST-Routen)
app.use('/assets',   express.static(path.join(__dirname, '../../server/public')));
app.use('/tictactoe', express.static(path.join(__dirname, '../../games/tictactoe')));
app.use('/docs',     express.static(path.join(__dirname, '../../docs')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Alle registrierten Spiele (gehostete + externe) — für Panel und externe Apps
app.get('/api/games', (_req, res) => {
  res.json(listGames());
});

app.get('/', (_req, res) => {
  const games = listGames();
  const gameCards = games.length === 0
    ? `<p class="empty">Noch keine Spiele verfügbar.</p>`
    : games.map(g => {
        if (!g.hosted) {
          // Externe Spiele: kein interner Link, stattdessen optionaler externer Button
          const externalBtn = g.link
            ? `<a class="play-btn external-btn" href="${g.link}" target="_blank" rel="noopener noreferrer">Zum Spiel ↗</a>`
            : `<span class="ext-badge">Externer Client</span>`;
          return `
      <div class="card external-card">
        <h2>${g.name}</h2>
        <p>${g.description}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;">
          <span class="badge">Bis zu ${g.maxPlayers} Spieler</span>
          ${externalBtn}
        </div>
      </div>`;
        }
        // Gehostete Spiele: normaler interner Link
        return `
      <a href="/${g.id}/" class="card-link">
        <div class="card">
          <h2>${g.name}</h2>
          <p>${g.description}</p>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;">
            <span class="badge">Bis zu ${g.maxPlayers} Spieler</span>
            <span class="play-btn">Spielen →</span>
          </div>
        </div>
      </a>`;
      }).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ethernal Cosmos</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #0d0d1a;
      color: #e0e0f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1rem;
    }
    header { text-align: center; margin-bottom: 3rem; }
    header h1 { font-size: 2.5rem; letter-spacing: .1em; color: #a78bfa; }
    header p  { margin-top: .5rem; color: #94a3b8; }
    .status {
      display: inline-flex; align-items: center; gap: .5rem;
      background: #1e1e3a; border: 1px solid #2d2d5a;
      border-radius: 999px; padding: .35rem 1rem;
      font-size: .85rem; color: #6ee7b7; margin-top: 1rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #6ee7b7;
           animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    h2.section { font-size: 1.1rem; color: #94a3b8; margin-bottom: 1.5rem;
                 text-transform: uppercase; letter-spacing: .12em; }
    .grid { display: grid; gap: 1.5rem;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            width: 100%; max-width: 900px; }
    .card {
      background: #1a1a2e; border: 1px solid #2d2d5a;
      border-radius: 12px; padding: 1.5rem;
      transition: border-color .2s;
    }
    .card:hover { border-color: #7c3aed; }
    .card h2 { font-size: 1.25rem; color: #c4b5fd; margin-bottom: .5rem; }
    .card p  { color: #94a3b8; font-size: .9rem; line-height: 1.5; }
    .badge {
      display: inline-block; margin-top: 1rem;
      background: #2d1b69; color: #a78bfa;
      border-radius: 999px; padding: .2rem .75rem; font-size: .8rem;
    }
    .empty { color: #475569; font-style: italic; }
    .card-link { text-decoration: none; display: block; }
    .card-link .card { cursor: pointer; }
    .play-btn {
      background: #7c3aed; color: #fff;
      border-radius: 8px; padding: .35rem .9rem;
      font-size: .85rem; font-weight: bold;
      transition: background .15s;
    }
    .card-link:hover .play-btn { background: #6d28d9; }
    .external-card { cursor: default; }
    .external-btn {
      background: #0f766e; color: #fff; text-decoration: none;
      border-radius: 8px; padding: .35rem .9rem;
      font-size: .85rem; font-weight: bold;
      transition: background .15s;
    }
    .external-btn:hover { background: #0d9488; }
    .ext-badge {
      background: #1e293b; color: #64748b;
      border-radius: 8px; padding: .35rem .9rem;
      font-size: .85rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>✦ Ethernal Cosmos</h1>
    <p>Multiplayer Game Hub</p>
    <div class="status"><span class="dot"></span> Server läuft &nbsp;·&nbsp; intern ${HOST}:${PORT}</div>
  </header>
  <h2 class="section">Verfügbare Spiele</h2>
  <div class="grid">${gameCards}</div>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <script src="/assets/panel.js"></script>
</body>
</html>`);
});

// Verfügbare Spiele auflisten (für die Spielauswahl im Client)
app.get('/games', (_req, res) => {
  res.json(listGames());
});

app.use('/auth', authRouter);
app.use('/userdata', userDataRouter);
app.use('/players', playerDataRouter);
app.use('/leaderboard', leaderboardRouter);

// ─── Start ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await initDatabase();
  httpServer.listen(PORT, HOST, () => {
    console.log(`[Server] Ethernal Cosmos Hub läuft auf ${HOST}:${PORT} (intern — HTTPS via Caddy auf :12346)`);
  });
}

start().catch((err) => {
  console.error('[Server] Startup-Fehler:', err);
  process.exit(1);
});

export { io };
