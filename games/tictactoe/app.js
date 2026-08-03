function normalizeHubUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

const search = new URLSearchParams(window.location.search);
const hubFromQuery = normalizeHubUrl(search.get('hub'));
const hubFromSession = normalizeHubUrl(sessionStorage.getItem('ec_hub_url'));
const defaultHub = window.location.pathname.startsWith('/tictactoe')
  ? window.location.origin
  : 'https://mea-sama.duckdns.org:12346';

const ETHERNAL = hubFromQuery ?? hubFromSession ?? defaultHub;
sessionStorage.setItem('ec_hub_url', ETHERNAL);

let token = null;
let refreshToken = null;
let myUserId = null;
let myUsername = null;
let socket = null;

let lobbyId = null;
let hostUserId = null;
let mySymbol = null;
let isHost = false;
let symbolByUserId = {};
let playerNames = { X: '?', O: '?' };
let playerSignature = '';
let pendingGuestMove = false;

let gameState = createFreshState();
let authMode = 'login';

const els = {
  status: document.getElementById('status'),
  auth: document.getElementById('s-auth'),
  lobby: document.getElementById('s-lobby'),
  wait: document.getElementById('s-wait'),
  game: document.getElementById('s-game'),
  tabLogin: document.getElementById('tab-login'),
  tabReg: document.getElementById('tab-reg'),
  btnAuth: document.getElementById('btn-auth'),
  authUser: document.getElementById('auth-user'),
  authPass: document.getElementById('auth-pass'),
  authErr: document.getElementById('auth-err'),
  btnCreate: document.getElementById('btn-create'),
  btnJoin: document.getElementById('btn-join'),
  btnCopy: document.getElementById('btn-copy'),
  btnCancelWait: document.getElementById('btn-cancel-wait'),
  btnLeaveGame: document.getElementById('btn-leave-game'),
  codeIn: document.getElementById('code-in'),
  inviteCode: document.getElementById('invite-code'),
  waitMsg: document.getElementById('wait-msg'),
  turn: document.getElementById('turn'),
  board: document.getElementById('board'),
  resultBox: document.getElementById('result-box'),
  nameX: document.getElementById('name-x'),
  nameO: document.getElementById('name-o'),
  cardX: document.getElementById('card-x'),
  cardO: document.getElementById('card-o'),
};

function createFreshState() {
  return {
    version: 0,
    board: Array(9).fill(null),
    currentTurn: 'X',
    active: false,
    winner: null,
    winLine: [],
  };
}

function setStatus(msg, cls = '') {
  els.status.textContent = msg;
  els.status.className = cls;
}

function show(name) {
  ['auth', 'lobby', 'wait', 'game'].forEach((key) => {
    els[key].classList.toggle('hidden', key !== name);
  });
}

function switchTab(mode) {
  authMode = mode;
  els.tabLogin.classList.toggle('active', mode === 'login');
  els.tabReg.classList.toggle('active', mode === 'reg');
  els.btnAuth.textContent = mode === 'login' ? 'Anmelden' : 'Registrieren';
  els.authPass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  els.authErr.textContent = '';
}

async function doAuth() {
  const username = els.authUser.value.trim();
  const password = els.authPass.value;
  els.authErr.textContent = '';
  if (!username || !password) {
    els.authErr.textContent = 'Benutzername und Passwort erforderlich.';
    return;
  }

  const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
  els.btnAuth.disabled = true;
  try {
    const response = await fetch(ETHERNAL + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      els.authErr.textContent = data.error ?? (authMode === 'login' ? 'Anmeldung fehlgeschlagen.' : 'Registrierung fehlgeschlagen.');
      return;
    }

    token = data.accessToken;
    refreshToken = data.refreshToken;
    myUserId = data.user.id;
    myUsername = data.user.username;

    sessionStorage.setItem('ec_token', token);
    sessionStorage.setItem('ec_refresh', refreshToken);
    sessionStorage.setItem('ec_user', myUsername);
    sessionStorage.setItem('ec_userId', myUserId);

    window.EthernalPanel?.setContext({ gameTitle: 'TicTacToe' });
    setStatus('Verbinde...');
    connectSocket();
  } catch (error) {
    els.authErr.textContent = 'Verbindungsfehler: ' + (error?.message ?? error);
  } finally {
    els.btnAuth.disabled = false;
  }
}

async function logout() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  if (refreshToken) {
    try {
      await fetch(ETHERNAL + '/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // best effort
    }
  }

  resetSessionState();
  els.authUser.value = '';
  els.authPass.value = '';
  els.authErr.textContent = '';
  setStatus('Abgemeldet', 'warn');
  show('auth');
}

function resetSessionState() {
  token = null;
  refreshToken = null;
  myUserId = null;
  myUsername = null;
  lobbyId = null;
  hostUserId = null;
  mySymbol = null;
  isHost = false;
  symbolByUserId = {};
  playerNames = { X: '?', O: '?' };
  playerSignature = '';
  pendingGuestMove = false;
  gameState = createFreshState();

  sessionStorage.removeItem('ec_token');
  sessionStorage.removeItem('ec_refresh');
  sessionStorage.removeItem('ec_user');
  sessionStorage.removeItem('ec_userId');

  window.EthernalPanel?.setLobby(null);
  window.EthernalPanel?.clearActions();

  els.codeIn.value = '';
  els.inviteCode.textContent = '------';
  els.resultBox.classList.add('hidden');
  renderBoard();
  updateTurn();
}

function connectSocket() {
  socket = io(ETHERNAL, { auth: { token: 'Bearer ' + token } });

  socket.on('connect', () => {
    setStatus('Bereit ✓', 'ok');
    show('lobby');
  });

  socket.on('disconnect', () => {
    setStatus('Verbindung getrennt', 'warn');
  });

  socket.on('connect_error', async (error) => {
    if (error.message === 'INVALID_TOKEN' && refreshToken) {
      try {
        const response = await fetch(ETHERNAL + '/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (response.ok) {
          const data = await response.json();
          token = data.accessToken;
          refreshToken = data.refreshToken;
          sessionStorage.setItem('ec_token', token);
          sessionStorage.setItem('ec_refresh', refreshToken);
          socket.auth = { token: 'Bearer ' + token };
          socket.connect();
          return;
        }
      } catch {
        // fallthrough
      }

      resetSessionState();
      setStatus('Sitzung abgelaufen – bitte erneut anmelden', 'warn');
      show('auth');
      return;
    }

    setStatus('Verbindungsfehler: ' + error.message, 'err');
  });

  socket.on('error', (message) => setStatus(message, 'err'));

  socket.on('lobbyCreated', (lobby) => {
    applyLobbySnapshot(lobby);
    els.inviteCode.textContent = lobby.inviteCode ?? '------';
    els.waitMsg.textContent = 'Warte auf Gegner...';
    show('wait');
    setStatus('Lobby erstellt', 'ok');
  });

  socket.on('lobbyUpdated', (lobby) => {
    applyLobbySnapshot(lobby);

    const count = lobby.players.length;
    if (count < 2) {
      gameState.active = false;
      gameState.winner = null;
      gameState.winLine = [];
      pendingGuestMove = false;
      updateTurn();

      if (count === 1) {
        if (isHost) {
          els.inviteCode.textContent = lobby.inviteCode ?? '------';
          els.waitMsg.textContent = 'Gegner hat verlassen. Warte auf neuen Spieler...';
          show('wait');
          setStatus('Spieler hat die Lobby verlassen', 'warn');
        } else {
          show('lobby');
          setStatus('Lobby nicht spielbereit', 'warn');
        }
      }
      return;
    }

    show('game');

    const signature = lobby.players.map((p) => p.userId).sort().join(':');
    const changedPlayers = signature !== playerSignature;
    playerSignature = signature;

    if (isHost && (changedPlayers || !gameState.active)) {
      hostStartNewRound();
    }

    if (!isHost) {
      setStatus('Warte auf Host-Sync...', 'warn');
    } else {
      setStatus('Spiel läuft!', 'ok');
    }
  });

  socket.on('message', ({ from, type, payload }) => {
    if (type === 'stateSync') {
      applyIncomingState(payload);
      return;
    }

    if (type === 'moveRequest' && isHost) {
      handleMoveRequest(from, payload);
      return;
    }

    if (type === 'rematchRequest' && isHost) {
      if (!gameState.active) {
        hostStartNewRound();
      }
    }
  });

  socket.on('playerKicked', () => {
    leaveGame(true);
    setStatus('Du wurdest aus der Lobby entfernt', 'warn');
  });
}

function applyLobbySnapshot(lobby) {
  lobbyId = lobby.id;
  hostUserId = lobby.hostId;
  isHost = hostUserId === myUserId;

  const host = lobby.players.find((p) => p.userId === lobby.hostId);
  const guest = lobby.players.find((p) => p.userId !== lobby.hostId);

  symbolByUserId = {};
  if (host) symbolByUserId[host.userId] = 'X';
  if (guest) symbolByUserId[guest.userId] = 'O';

  mySymbol = symbolByUserId[myUserId] ?? null;
  playerNames = {
    X: host?.username ?? '?',
    O: guest?.username ?? '?',
  };

  els.nameX.textContent = playerNames.X;
  els.nameO.textContent = playerNames.O;
  window.EthernalPanel?.setLobby(lobby.id);
  setupPanelActions();
}

function setupPanelActions() {
  window.EthernalPanel?.clearActions();
  window.EthernalPanel?.registerAction({
    id: 'leave',
    label: 'Spiel verlassen',
    icon: '🚪',
    style: 'danger',
    onClick: () => leaveGame(false),
  });
}

function createGame() {
  if (!socket?.connected) return;
  socket.emit('createLobby', {
    gameId: 'tictactoe',
    name: 'TicTacToe von ' + myUsername,
    isPrivate: true,
  });
}

function joinGame() {
  if (!socket?.connected) return;
  const code = els.codeIn.value.trim().toUpperCase();
  if (code.length !== 6) {
    setStatus('6-stelligen Code eingeben', 'warn');
    return;
  }
  socket.emit('joinLobbyByCode', { code });
}

function sanitizeCodeInput() {
  const sanitized = els.codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (sanitized !== els.codeIn.value) {
    els.codeIn.value = sanitized;
  }
}

function copyCode() {
  const code = els.inviteCode.textContent;
  navigator.clipboard?.writeText(code)
    .then(() => setStatus('Code kopiert!', 'ok'))
    .catch(() => setStatus('Code: ' + code, 'ok'));
}

function hostStartNewRound() {
  if (!isHost || !socket?.connected) return;

  gameState = {
    version: gameState.version + 1,
    board: Array(9).fill(null),
    currentTurn: 'X',
    active: true,
    winner: null,
    winLine: [],
  };

  pendingGuestMove = false;
  renderBoard();
  updateTurn();
  els.resultBox.classList.add('hidden');

  socket.emit('sendToLobby', { type: 'stateSync', payload: gameState });
  setStatus('Spiel läuft!', 'ok');
}

function applyIncomingState(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (!Array.isArray(payload.board) || payload.board.length !== 9) return;
  if (!Number.isInteger(payload.version)) return;
  if (payload.version < gameState.version) return;

  gameState = {
    version: payload.version,
    board: payload.board.map((cell) => (cell === 'X' || cell === 'O' ? cell : null)),
    currentTurn: payload.currentTurn === 'O' ? 'O' : 'X',
    active: !!payload.active,
    winner: payload.winner === 'X' || payload.winner === 'O' || payload.winner === 'draw' ? payload.winner : null,
    winLine: Array.isArray(payload.winLine) ? payload.winLine.filter((n) => Number.isInteger(n)) : [],
  };

  pendingGuestMove = false;
  renderBoard();
  updateTurn();

  if (!gameState.active && gameState.winner) {
    showResult(gameState.winner);
  } else {
    els.resultBox.classList.add('hidden');
    setStatus('Spiel läuft!', 'ok');
  }
}

function updateTurn() {
  if (!gameState.active) {
    els.turn.textContent = '';
    els.cardX.classList.toggle('active', false);
    els.cardO.classList.toggle('active', false);
    return;
  }

  const mine = gameState.currentTurn === mySymbol;
  if (pendingGuestMove) {
    els.turn.textContent = '⬤ Zug wird bestätigt...';
    els.turn.style.color = '#fbbf24';
  } else {
    els.turn.textContent = mine ? '⬤ Dein Zug' : '⬤ Gegner ist dran';
    els.turn.style.color = mine ? '#6ee7b7' : '#94a3b8';
  }

  els.cardX.classList.toggle('active', gameState.currentTurn === 'X');
  els.cardO.classList.toggle('active', gameState.currentTurn === 'O');
}

function renderBoard() {
  els.board.innerHTML = '';
  const myTurn = gameState.active && gameState.currentTurn === mySymbol && !pendingGuestMove;

  gameState.board.forEach((cell, index) => {
    const cellEl = document.createElement('div');
    const isWin = gameState.winLine.includes(index);

    cellEl.className = 'cell'
      + (cell ? ' taken ' + cell.toLowerCase() : '')
      + (!cell && !myTurn ? ' off' : '')
      + (isWin ? ' win' : '');

    cellEl.textContent = cell === 'X' ? '✕' : cell === 'O' ? '○' : '';

    if (!cell && myTurn) {
      cellEl.addEventListener('click', () => onCellClick(index));
    }

    els.board.appendChild(cellEl);
  });
}

function onCellClick(index) {
  if (!gameState.active || gameState.board[index] || gameState.currentTurn !== mySymbol) return;
  if (!socket?.connected || !mySymbol) return;

  if (isHost) {
    hostApplyMove(index, mySymbol);
    return;
  }

  if (!hostUserId) {
    setStatus('Kein Host verfügbar', 'warn');
    return;
  }

  pendingGuestMove = true;
  updateTurn();
  socket.emit('sendToPlayer', {
    playerId: hostUserId,
    type: 'moveRequest',
    payload: { cell: index },
  });
}

function handleMoveRequest(fromUserId, payload) {
  if (!isHost || !gameState.active) return;
  if (!payload || typeof payload.cell !== 'number') return;

  const senderSymbol = symbolByUserId[fromUserId];
  if (!senderSymbol) return;
  hostApplyMove(payload.cell, senderSymbol);
}

function hostApplyMove(index, symbol) {
  if (!isHost || !socket?.connected) return;
  if (!Number.isInteger(index) || index < 0 || index > 8) return;
  if (!gameState.active) return;
  if (gameState.currentTurn !== symbol) return;
  if (gameState.board[index]) return;

  const nextBoard = [...gameState.board];
  nextBoard[index] = symbol;

  const result = winner(nextBoard);
  if (result) {
    gameState = {
      version: gameState.version + 1,
      board: nextBoard,
      currentTurn: gameState.currentTurn,
      active: false,
      winner: result.w,
      winLine: result.line,
    };
  } else {
    gameState = {
      version: gameState.version + 1,
      board: nextBoard,
      currentTurn: gameState.currentTurn === 'X' ? 'O' : 'X',
      active: true,
      winner: null,
      winLine: [],
    };
  }

  renderBoard();
  updateTurn();

  if (!gameState.active && gameState.winner) {
    showResult(gameState.winner);
  } else {
    els.resultBox.classList.add('hidden');
  }

  socket.emit('sendToLobby', { type: 'stateSync', payload: gameState });
}

function winner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (const line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { w: board[a], line };
    }
  }

  if (board.every((cell) => cell)) {
    return { w: 'draw', line: [] };
  }

  return null;
}

function showResult(winnerValue) {
  els.resultBox.classList.remove('hidden');

  let title = '';
  let cls = '';
  if (winnerValue === 'draw') {
    title = 'Unentschieden!';
    cls = 'draw';
  } else if (winnerValue === mySymbol) {
    title = 'Du gewinnst!';
    cls = 'win';
  } else {
    title = 'Gegner gewinnt';
    cls = 'lose';
  }

  els.resultBox.innerHTML = '';

  const titleEl = document.createElement('div');
  titleEl.className = `rt ${cls}`;
  titleEl.textContent = title;

  const rematchButton = document.createElement('button');
  rematchButton.className = 'btn mt-sm';
  rematchButton.textContent = 'Nochmal';
  rematchButton.addEventListener('click', rematch);

  els.resultBox.appendChild(titleEl);
  els.resultBox.appendChild(rematchButton);
}

function rematch() {
  if (!socket?.connected || !lobbyId) return;

  if (isHost) {
    hostStartNewRound();
    return;
  }

  if (!hostUserId) {
    setStatus('Kein Host verfügbar', 'warn');
    return;
  }

  socket.emit('sendToPlayer', {
    playerId: hostUserId,
    type: 'rematchRequest',
    payload: {},
  });
  setStatus('Rematch angefragt...', 'ok');
}

function leaveGame(wasRemote) {
  if (!wasRemote && socket?.connected) {
    socket.emit('leaveLobby');
  }

  lobbyId = null;
  hostUserId = null;
  mySymbol = null;
  isHost = false;
  symbolByUserId = {};
  playerNames = { X: '?', O: '?' };
  playerSignature = '';
  pendingGuestMove = false;
  gameState = createFreshState();

  window.EthernalPanel?.setLobby(null);
  window.EthernalPanel?.clearActions();

  els.codeIn.value = '';
  els.inviteCode.textContent = '------';
  els.nameX.textContent = '—';
  els.nameO.textContent = '—';
  els.resultBox.classList.add('hidden');

  renderBoard();
  updateTurn();
  show('lobby');

  if (!wasRemote) {
    setStatus('Bereit ✓', 'ok');
  }
}

function restoreSession() {
  const t = sessionStorage.getItem('ec_token');
  const r = sessionStorage.getItem('ec_refresh');
  const u = sessionStorage.getItem('ec_user');
  const id = sessionStorage.getItem('ec_userId');

  if (t && r && u && id) {
    token = t;
    refreshToken = r;
    myUsername = u;
    myUserId = id;
    window.EthernalPanel?.setContext({ gameTitle: 'TicTacToe' });
    setStatus('Verbinde...');
    connectSocket();
    return;
  }

  setStatus('Bitte anmelden');
  show('auth');
}

function wireEvents() {
  els.tabLogin.addEventListener('click', () => switchTab('login'));
  els.tabReg.addEventListener('click', () => switchTab('reg'));
  els.btnAuth.addEventListener('click', doAuth);
  els.btnCreate.addEventListener('click', createGame);
  els.btnJoin.addEventListener('click', joinGame);
  els.btnCopy.addEventListener('click', copyCode);
  els.btnCancelWait.addEventListener('click', () => leaveGame(false));
  els.btnLeaveGame.addEventListener('click', () => leaveGame(false));
  els.codeIn.addEventListener('input', sanitizeCodeInput);

  window.addEventListener('ethernal:logout', () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    resetSessionState();
    show('auth');
    setStatus('Abgemeldet', 'warn');
  });
}

wireEvents();
renderBoard();
updateTurn();
restoreSession();
window.logout = logout;
