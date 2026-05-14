/**
 * Ethernal Cosmos — Universal Social Panel
 * ==========================================
 * Einbindung in jedes Spiel: <script src="/assets/panel.js"></script>
 *
 * Exposes window.EthernalPanel mit folgender API:
 *   .open()                        — Panel öffnen
 *   .close()                       — Panel schließen
 *   .toggle()                      — umschalten
 *   .setLobby(lobbyId | null)      — Lobby-Kontext setzen; Panel subscribed auf lobbyUpdated
 *   .setContext({ gameTitle? })    — Spielname im Panel-Header setzen
 *   .registerAction(PanelAction)   — Spielspezifischen Button hinzufügen
 *   .removeAction(id)              — Button entfernen
 *   .clearActions()                — Alle spielspezifischen Buttons entfernen
 */
(function () {
  'use strict';

  const ETHERNAL = location.origin;
  const STORAGE_TOKEN   = 'ec_token';
  const STORAGE_REFRESH = 'ec_refresh';
  const STORAGE_USER    = 'ec_user';

  // ── State ────────────────────────────────────────────────────────────────
  let socket = null;
  let currentLobbyId = null;
  let currentLobby = null;
  let presenceUsers = [];
  let registeredActions = [];
  let gameTitle = null;
  let isOpen = false;
  let gameRegistry = new Map(); // gameId → GameInfo, geladen beim Socket-Connect

  // ── Shadow DOM Root ───────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'ethernal-panel-host';
  host.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      :host { font-family: system-ui, -apple-system, sans-serif; }

      #toggle-btn {
        position: fixed;
        top: 14px;
        right: 16px;
        width: 38px;
        height: 38px;
        background: #1a1a2e;
        border: 1px solid #4c1d95;
        border-radius: 10px;
        color: #a78bfa;
        font-size: 1.1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: all;
        transition: background .15s, border-color .15s;
        box-shadow: 0 2px 12px #0008;
        z-index: 2147483646;
      }
      #toggle-btn:hover { background: #2d1b69; border-color: #7c3aed; }

      #panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 300px;
        height: 100vh;
        background: #0d0d1a;
        border-left: 1px solid #2d2d5a;
        display: flex;
        flex-direction: column;
        pointer-events: all;
        transform: translateX(100%);
        transition: transform .25s cubic-bezier(.4,0,.2,1);
        box-shadow: -4px 0 24px #0009;
        overflow: hidden;
      }
      #panel.open { transform: translateX(0); }

      .panel-header {
        padding: 1rem 1rem .75rem;
        border-bottom: 1px solid #1e1e3a;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .panel-header .brand { color: #a78bfa; font-size: .95rem; font-weight: 700; letter-spacing: .05em; }
      .panel-header .game-name { font-size: .7rem; color: #64748b; margin-top: .1rem; }
      .close-btn {
        background: transparent;
        border: none;
        color: #475569;
        font-size: 1.1rem;
        cursor: pointer;
        padding: .2rem .4rem;
        border-radius: 6px;
        transition: color .15s, background .15s;
        line-height: 1;
        margin-top: -2px;
      }
      .close-btn:hover { color: #e0e0f0; background: #1e1e3a; }

      .panel-body {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .panel-body::-webkit-scrollbar { width: 4px; }
      .panel-body::-webkit-scrollbar-track { background: transparent; }
      .panel-body::-webkit-scrollbar-thumb { background: #2d2d5a; border-radius: 99px; }

      .section {
        padding: .85rem 1rem;
        border-bottom: 1px solid #1a1a2e;
      }
      .section-title {
        font-size: .65rem;
        text-transform: uppercase;
        letter-spacing: .12em;
        color: #475569;
        margin-bottom: .6rem;
      }

      /* Auth section */
      .auth-info { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
      .auth-info .uname { font-size: .9rem; color: #c4b5fd; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .btn-sm {
        background: transparent;
        border: 1px solid #4c1d95;
        color: #94a3b8;
        border-radius: 7px;
        padding: .3rem .7rem;
        font-size: .78rem;
        cursor: pointer;
        white-space: nowrap;
        transition: all .15s;
        flex-shrink: 0;
      }
      .btn-sm:hover { background: #1e1e3a; }
      .btn-sm.danger:hover { color: #f87171; border-color: #7f1d1d; background: #1e1e3a; }
      .btn-sm.primary { background: #7c3aed; border-color: #7c3aed; color: #fff; }
      .btn-sm.primary:hover { background: #6d28d9; }
      .not-logged-in { font-size: .85rem; color: #64748b; }
      .not-logged-in a { color: #a78bfa; text-decoration: none; }
      .not-logged-in a:hover { text-decoration: underline; }

      /* Navigation */
      .nav-link {
        display: flex;
        align-items: center;
        gap: .6rem;
        color: #94a3b8;
        text-decoration: none;
        font-size: .875rem;
        padding: .4rem .5rem;
        border-radius: 8px;
        transition: background .12s, color .12s;
      }
      .nav-link:hover { background: #1a1a2e; color: #e0e0f0; }
      .nav-link .icon { width: 18px; text-align: center; font-size: 1rem; flex-shrink: 0; }

      /* Presence */
      .presence-list { display: flex; flex-direction: column; gap: .35rem; }
      .presence-item {
        display: flex;
        align-items: center;
        gap: .6rem;
        padding: .3rem .4rem;
        border-radius: 8px;
        transition: background .12s;
      }
      .presence-item:hover { background: #1a1a2e; }
      .avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: #2d1b69;
        color: #a78bfa;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: .75rem;
        font-weight: 700;
        flex-shrink: 0;
      }
      .presence-info { min-width: 0; flex: 1; }
      .presence-name { font-size: .82rem; color: #e0e0f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .presence-status { font-size: .68rem; color: #475569; }
      .presence-status.in-lobby  { color: #93c5fd; }
      .presence-status.in-game   { color: #6ee7b7; }
      .presence-status.extern    { color: #f9a8d4; }
      .join-btn {
        flex-shrink: 0;
        font-size: .65rem;
        padding: .18rem .45rem;
        border-radius: 6px;
        border: 1px solid #3b82f6;
        background: transparent;
        color: #93c5fd;
        cursor: pointer;
        transition: background .12s, color .12s;
        white-space: nowrap;
      }
      .join-btn:hover { background: #1e3a5f; color: #bfdbfe; }
      .empty-hint { font-size: .8rem; color: #475569; font-style: italic; }

      /* Toast */
      #ec-toast {
        position: fixed;
        bottom: 1.5rem;
        left: 50%;
        transform: translateX(-50%) translateY(2rem);
        background: #1e1e3a;
        border: 1px solid #4c1d95;
        color: #e0e0f0;
        font-size: .82rem;
        padding: .45rem 1rem;
        border-radius: 8px;
        opacity: 0;
        transition: opacity .2s, transform .2s;
        pointer-events: none;
        z-index: 2147483648;
        max-width: 220px;
        text-align: center;
      }
      #ec-toast.show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      /* Lobby */
      .lobby-title { font-size: .82rem; color: #c4b5fd; font-weight: 600; margin-bottom: .5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .lobby-players { display: flex; flex-direction: column; gap: .3rem; }
      .lobby-player {
        display: flex;
        align-items: center;
        gap: .5rem;
        font-size: .82rem;
        color: #94a3b8;
        padding: .2rem 0;
      }
      .lobby-player .host-badge {
        font-size: .65rem;
        background: #2d1b69;
        color: #a78bfa;
        border-radius: 4px;
        padding: .1rem .35rem;
        flex-shrink: 0;
      }

      /* Game Actions */
      .actions-list { display: flex; flex-direction: column; gap: .5rem; }
      .action-btn {
        width: 100%;
        background: #1a1a2e;
        border: 1px solid #2d2d5a;
        color: #e0e0f0;
        border-radius: 9px;
        padding: .6rem 1rem;
        font-size: .85rem;
        cursor: pointer;
        text-align: left;
        display: flex;
        align-items: center;
        gap: .6rem;
        transition: background .12s, border-color .15s;
      }
      .action-btn:hover { background: #21213d; border-color: #4c1d95; }
      .action-btn.danger { border-color: #4c1d1d; }
      .action-btn.danger:hover { background: #1e1010; border-color: #7f1d1d; color: #f87171; }

      /* Footer */
      .panel-footer {
        padding: .6rem 1rem;
        border-top: 1px solid #1a1a2e;
        font-size: .7rem;
        color: #2d2d5a;
        text-align: center;
        flex-shrink: 0;
      }
    </style>

    <button id="toggle-btn" title="Ethernal Panel öffnen">☰</button>

    <div id="panel">
      <div class="panel-header">
        <div>
          <div class="brand">✦ Ethernal Cosmos</div>
          <div class="game-name" id="game-name-label"></div>
        </div>
        <button class="close-btn" id="close-btn" title="Schließen">✕</button>
      </div>

      <div class="panel-body">

        <!-- Auth -->
        <div class="section" id="section-auth">
          <div class="section-title">Account</div>
          <div id="auth-content"></div>
        </div>

        <!-- Navigation -->
        <div class="section">
          <div class="section-title">Navigation</div>
          <a href="/" class="nav-link"><span class="icon">🏠</span> Hub-Startseite</a>
          <a href="/docs/" target="_blank" rel="noopener" class="nav-link"><span class="icon">📖</span> Documentation</a>
        </div>

        <!-- Lobby -->
        <div class="section" id="section-lobby" style="display:none">
          <div class="section-title">Aktuelle Lobby</div>
          <div id="lobby-content"></div>
        </div>

        <!-- Game Actions -->
        <div class="section" id="section-actions" style="display:none">
          <div class="section-title">Spieloptionen</div>
          <div class="actions-list" id="actions-list"></div>
        </div>

        <!-- Online -->
        <div class="section">
          <div class="section-title">Online (<span id="online-count">0</span>)</div>
          <div class="presence-list" id="presence-list">
            <div class="empty-hint">Niemand online</div>
          </div>
        </div>

      </div>

      <div class="panel-footer">Ethernal Cosmos Hub</div>
    </div>
  `;

  const toggleBtn   = shadow.getElementById('toggle-btn');
  const panel       = shadow.getElementById('panel');
  const closeBtn    = shadow.getElementById('close-btn');
  const authContent = shadow.getElementById('auth-content');
  const sectionLobby   = shadow.getElementById('section-lobby');
  const lobbyContent   = shadow.getElementById('lobby-content');
  const sectionActions = shadow.getElementById('section-actions');
  const actionsList    = shadow.getElementById('actions-list');
  const presenceList   = shadow.getElementById('presence-list');
  const onlineCount    = shadow.getElementById('online-count');
  const gameNameLabel  = shadow.getElementById('game-name-label');

  // ── Toggle ─────────────────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', () => api.toggle());
  closeBtn.addEventListener('click', () => api.close());

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (isOpen && !host.contains(e.target) && e.target !== host) {
      api.close();
    }
  }, true);

  // ── Auth Rendering ─────────────────────────────────────────────────────────
  function renderAuth() {
    const user   = sessionStorage.getItem(STORAGE_USER);
    const token  = sessionStorage.getItem(STORAGE_TOKEN);
    if (user && token) {
      authContent.innerHTML = `
        <div class="auth-info">
          <span class="uname">${escHtml(user)}</span>
          <button class="btn-sm danger" id="logout-btn">Abmelden</button>
        </div>`;
      shadow.getElementById('logout-btn').addEventListener('click', doLogout);
    } else {
      authContent.innerHTML = `
        <div class="not-logged-in">
          Nicht angemeldet &mdash; <a href="/">Zum Hub</a>
        </div>`;
    }
  }

  async function doLogout() {
    const token = sessionStorage.getItem(STORAGE_TOKEN);
    const rt    = sessionStorage.getItem(STORAGE_REFRESH);
    if (socket) { socket.disconnect(); socket = null; }
    if (rt) {
      try {
        await fetch(ETHERNAL + '/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ refreshToken: rt }),
        });
      } catch (_) {}
    }
    [STORAGE_TOKEN, STORAGE_REFRESH, STORAGE_USER, 'ec_userId'].forEach(k => sessionStorage.removeItem(k));
    presenceUsers = [];
    renderAuth();
    renderPresence();
    renderLobby();
    // Custom event damit das Spiel reagieren kann
    window.dispatchEvent(new CustomEvent('ethernal:logout'));
  }

  // ── Presence Rendering ─────────────────────────────────────────────────────
  function renderPresence() {
    onlineCount.textContent = presenceUsers.length;
    if (presenceUsers.length === 0) {
      presenceList.innerHTML = '<div class="empty-hint">Niemand online</div>';
      return;
    }
    const myId = sessionStorage.getItem('ec_userId');
    presenceList.innerHTML = presenceUsers.map(u => {
      const initials = u.username.slice(0, 2).toUpperCase();
      let statusText = 'Im Hub';
      let statusCls  = '';
      let joinBtn    = '';

      if (u.lobbyId && u.gameId) {
        const game = gameRegistry.get(u.gameId);
        const gameName = game ? game.name : u.gameId;
        if (!game || !game.hosted) {
          // Externes Spiel
          statusText = 'Extern: ' + gameName;
          statusCls  = 'extern';
        } else if (u.lobbyStatus === 'open' && u.userId !== myId) {
          // Gehostetes Spiel, Lobby noch offen → Join-Button
          statusText = 'Wartet auf Mitspieler';
          statusCls  = 'in-lobby';
          joinBtn = `<button class="join-btn" data-lobby="${escHtml(u.lobbyId)}">Beitreten</button>`;
        } else if (u.lobbyStatus === 'open' && u.userId === myId) {
          statusText = 'Wartet auf Mitspieler';
          statusCls  = 'in-lobby';
        } else {
          // full oder closed
          statusText = 'Im Spiel: ' + gameName;
          statusCls  = 'in-game';
        }
      }

      const meIndicator = u.userId === myId ? ' (Du)' : '';
      return `<div class="presence-item">
        <div class="avatar">${escHtml(initials)}</div>
        <div class="presence-info">
          <div class="presence-name">${escHtml(u.username)}${meIndicator}</div>
          <div class="presence-status ${statusCls}">${statusText}</div>
        </div>
        ${joinBtn}
      </div>`;
    }).join('');

    // Join-Button Event-Handler
    presenceList.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!socket) return;
        const lobbyId = btn.dataset.lobby;
        socket.emit('joinLobby', { lobbyId });
        btn.disabled = true;
        btn.textContent = '...';
      });
    });
  }

  // ── Lobby Rendering ────────────────────────────────────────────────────────
  function renderLobby() {
    if (!currentLobby) {
      sectionLobby.style.display = 'none';
      return;
    }
    sectionLobby.style.display = '';
    const players = currentLobby.players ?? [];
    lobbyContent.innerHTML = `
      <div class="lobby-title">${escHtml(currentLobby.name ?? 'Lobby')}</div>
      <div class="lobby-players">
        ${players.map(p => `
          <div class="lobby-player">
            <div class="avatar" style="width:22px;height:22px;font-size:.6rem">${escHtml(p.username.slice(0,2).toUpperCase())}</div>
            ${escHtml(p.username)}
            ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
          </div>`).join('')}
      </div>`;
  }

  // ── Actions Rendering ──────────────────────────────────────────────────────
  function renderActions() {
    if (registeredActions.length === 0) {
      sectionActions.style.display = 'none';
      return;
    }
    sectionActions.style.display = '';
    actionsList.innerHTML = registeredActions.map(a =>
      `<button class="action-btn${a.style === 'danger' ? ' danger' : ''}" data-id="${escHtml(a.id)}">
        ${a.icon ? `<span>${escHtml(a.icon)}</span>` : ''}
        ${escHtml(a.label)}
      </button>`
    ).join('');
    actionsList.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = registeredActions.find(a => a.id === btn.dataset.id);
        if (action) action.onClick();
      });
    });
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  const toastEl = document.createElement('div');
  toastEl.id = 'ec-toast';
  shadow.appendChild(toastEl);
  let _toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  // ── Socket ─────────────────────────────────────────────────────────────────
  function connectSocket() {
    const token = sessionStorage.getItem(STORAGE_TOKEN);
    if (!token || socket) return;

    // socket.io ist von der Spiel-Seite bereits geladen
    if (typeof io === 'undefined') {
      console.warn('[EthernalPanel] socket.io nicht gefunden — Panel lädt nach 2s neu');
      setTimeout(connectSocket, 2000);
      return;
    }

    socket = io(ETHERNAL, { auth: { token: 'Bearer ' + token, clientType: 'panel' } });

    // Spiele-Registry einmalig laden (gecacht bis reconnect)
    fetch(ETHERNAL + '/api/games')
      .then(r => r.json())
      .then(games => {
        gameRegistry = new Map(games.map(g => [g.id, g]));
        renderPresence();
      })
      .catch(() => {}); // nicht kritisch

    socket.on('connect', () => {
      socket.emit('presence:list');
      // Lobby wieder subscriben wenn vorhanden
      if (currentLobbyId) socket.emit('getLobbyInfo');
    });

    socket.on('presence:list', (users) => {
      presenceUsers = users;
      renderPresence();
    });

    socket.on('presence:joined', (user) => {
      const idx = presenceUsers.findIndex(u => u.userId === user.userId);
      if (idx >= 0) presenceUsers[idx] = user;
      else presenceUsers.push(user);
      renderPresence();
    });

    socket.on('presence:left', ({ userId }) => {
      presenceUsers = presenceUsers.filter(u => u.userId !== userId);
      renderPresence();
    });

    socket.on('lobbyUpdated', (lobby) => {
      if (lobby.id === currentLobbyId) {
        currentLobby = lobby;
        renderLobby();
      }
      // Presence-Status der Lobby-Mitglieder aktualisieren (z.B. full nach Join)
      presenceUsers = presenceUsers.map(u =>
        u.lobbyId === lobby.id ? { ...u, lobbyStatus: lobby.status } : u
      );
      renderPresence();
    });

    socket.on('error', (msg) => {
      showToast(msg);
      // Join-Button ggf. reaktivieren
      presenceList.querySelectorAll('.join-btn').forEach(btn => {
        btn.disabled = false;
        btn.textContent = 'Beitreten';
      });
    });

    socket.on('lobbyCreated', () => { renderPresence(); });
    socket.on('lobbyInfo', (lobby) => {
      currentLobby = lobby;
      renderLobby();
    });

    socket.on('disconnect', () => {
      socket = null;
    });

    socket.on('connect_error', () => {
      socket = null;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const api = {
    open() {
      isOpen = true;
      panel.classList.add('open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      renderAuth();
      renderPresence();
      renderLobby();
      renderActions();
      if (!socket) connectSocket();
    },
    close() {
      isOpen = false;
      panel.classList.remove('open');
      toggleBtn.setAttribute('aria-expanded', 'false');
    },
    toggle() {
      if (isOpen) api.close(); else api.open();
    },

    setLobby(lobbyId) {
      currentLobbyId = lobbyId;
      if (!lobbyId) {
        currentLobby = null;
        renderLobby();
        return;
      }
      if (socket) socket.emit('getLobbyInfo');
    },

    setContext({ gameTitle: title } = {}) {
      gameTitle = title ?? null;
      gameNameLabel.textContent = gameTitle ?? '';
    },

    registerAction(action) {
      const idx = registeredActions.findIndex(a => a.id === action.id);
      if (idx >= 0) registeredActions[idx] = action;
      else registeredActions.push(action);
      if (isOpen) renderActions();
    },

    removeAction(id) {
      registeredActions = registeredActions.filter(a => a.id !== id);
      if (isOpen) renderActions();
    },

    clearActions() {
      registeredActions = [];
      if (isOpen) renderActions();
    },
  };

  window.EthernalPanel = api;

  // Auto-connect if token already present (e.g. returning to page)
  if (sessionStorage.getItem(STORAGE_TOKEN)) {
    connectSocket();
  }
})();
