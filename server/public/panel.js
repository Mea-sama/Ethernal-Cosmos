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
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <link rel="stylesheet" href="/assets/panel.css">

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
        <div class="section hidden" id="section-lobby">
          <div class="section-title">Aktuelle Lobby</div>
          <div id="lobby-content"></div>
        </div>

        <!-- Game Actions -->
        <div class="section hidden" id="section-actions">
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
      sectionLobby.classList.add('hidden');
      return;
    }
    sectionLobby.classList.remove('hidden');
    const players = currentLobby.players ?? [];
    lobbyContent.innerHTML = `
      <div class="lobby-title">${escHtml(currentLobby.name ?? 'Lobby')}</div>
      <div class="lobby-players">
        ${players.map(p => `
          <div class="lobby-player">
            <div class="avatar avatar-sm">${escHtml(p.username.slice(0,2).toUpperCase())}</div>
            ${escHtml(p.username)}
            ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
          </div>`).join('')}
      </div>`;
  }

  // ── Actions Rendering ──────────────────────────────────────────────────────
  function renderActions() {
    if (registeredActions.length === 0) {
      sectionActions.classList.add('hidden');
      return;
    }
    sectionActions.classList.remove('hidden');
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
