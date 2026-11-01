import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
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
import { accountRouter } from './account/account.router';
import { userDataRouter, playerDataRouter, leaderboardRouter } from './user-data/userdata.router';
import { dudgQuestionsRouter } from './games/dudg/dudg-questions.router';
import { registerSocketAuth, registerLobbyHandlers, registerIpcRouting } from './lobby/lobby.socket';
import { registerSocialHandlers } from './social/social.socket';
import { registerGameServerNamespace } from './gameserver/gameserver.socket';
import { gameServerAdminRouter } from './gameserver/admin.router';
import { socialRouter } from './social/social.router';
import { restRateLimit } from './limits/rest-rate-limit';
import { registerSocialJobs } from './social/social.jobs';
import { listGames } from './games/game.registry';
import { ALLOWED_ORIGINS, HOST, IS_PRODUCTION, PORT, isAllowedOrigin } from './config/env';
import { serverLimits } from './config/limits';
import { registerMaintenanceJobs } from './jobs/maintenance';
import { startScheduler } from './jobs/scheduler';

const socketIoClientCandidates = [
  path.resolve(__dirname, '../../node_modules/socket.io/client-dist'),
  path.resolve(__dirname, '../node_modules/socket.io/client-dist'),
];
const socketIoClientDir = socketIoClientCandidates.find((candidate) => fs.existsSync(candidate));

if (!socketIoClientDir) {
  throw new Error('[Startup] Konnte socket.io client-dist nicht finden. Bitte Abhängigkeiten installieren.');
}

// Intern: Node.js lauscht nur auf localhost. Caddy übernimmt TLS extern auf :12346.

const app = express();
const httpServer = createServer(app);

// ─── Middleware ──────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string);
}

function safeExternalLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

const corsOptions = {
  origin(origin: string | undefined, callback: (err: Error | null, success?: boolean) => void): void {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin nicht erlaubt: ${origin ?? 'unknown'}`));
  },
};

app.use(cors(corsOptions));
app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ─── Socket.io ──────────────────────────────────────────────────────────────

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  httpServer,
  {
    cors: {
      origin: ALLOWED_ORIGINS,
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
registerSocialHandlers(io);
registerGameServerNamespace(io);

// ─── REST Routes ─────────────────────────────────────────────────────────────

app.use('/assets', express.static(socketIoClientDir));
// Statische Assets + Spiele-Clients + Docs (vor REST-Routen)
app.use('/assets',   express.static(path.join(__dirname, '../../server/public')));
app.use('/tictactoe', express.static(path.join(__dirname, '../../games/tictactoe')));
app.use('/dudg',     express.static(path.join(__dirname, '../../games/dudg/client')));
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
        const safeName = escapeHtml(g.name);
        const safeDescription = escapeHtml(g.description);
        const safeGameId = encodeURIComponent(g.id);
        const safeLink = safeExternalLink(g.link);

        if (!g.hosted) {
          // Externe Spiele: kein interner Link, stattdessen optionaler externer Button
          const externalBtn = safeLink
            ? `<a class="play-btn external-btn" href="${safeLink}" target="_blank" rel="noopener noreferrer">Zum Spiel ↗</a>`
            : `<span class="ext-badge">Externer Client</span>`;
          return `
      <div class="card external-card">
        <h2>${safeName}</h2>
        <p>${safeDescription}</p>
          <div class="card-meta">
          <span class="badge">Bis zu ${g.maxPlayers} Spieler</span>
          ${externalBtn}
        </div>
      </div>`;
        }
        // Gehostete Spiele: normaler interner Link
        return `
      <a href="/${safeGameId}/" class="card-link">
        <div class="card">
          <h2>${safeName}</h2>
          <p>${safeDescription}</p>
          <div class="card-meta">
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
  <link rel="stylesheet" href="/assets/hub.css">
</head>
<body>
  <header>
    <h1>✦ Ethernal Cosmos</h1>
    <p>Multiplayer Game Hub</p>
    <div class="status"><span class="dot"></span> Server läuft &nbsp;·&nbsp; intern ${HOST}:${PORT}</div>
  </header>
  <h2 class="section">Verfügbare Spiele</h2>
  <div class="grid">${gameCards}</div>
  <script src="/assets/socket.io.min.js"></script>
  <script src="/assets/panel.js"></script>
</body>
</html>`);
});

// Verfügbare Spiele auflisten (für die Spielauswahl im Client)
app.get('/games', (_req, res) => {
  res.json(listGames());
});

app.use('/auth', authRouter);
app.use('/account', accountRouter);
app.use('/userdata', restRateLimit('userdata'), userDataRouter);
app.use('/players', restRateLimit('players'), playerDataRouter);
app.use('/leaderboard', restRateLimit('leaderboard'), leaderboardRouter);
app.use('/social', restRateLimit('social'), socialRouter);
app.use('/admin/game-servers', gameServerAdminRouter);
app.use('/dudg/api/questions', dudgQuestionsRouter);

// ─── Start ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await initDatabase();
  registerMaintenanceJobs();
  registerSocialJobs();
  startScheduler();
  httpServer.listen(PORT, HOST, () => {
    console.log(`[Server] Ethernal Cosmos Hub läuft auf ${HOST}:${PORT} (intern — HTTPS via Caddy auf :12346)`);
    console.log(
      `[Limits] binary.maxPayloadBytes=${serverLimits.binary.maxPayloadBytes}, auth.login=${serverLimits.authRateLimits.login.max}/${serverLimits.authRateLimits.login.windowMs}ms`
    );
  });
}

start().catch((err) => {
  console.error('[Server] Startup-Fehler:', err);
  process.exit(1);
});

export { io };
