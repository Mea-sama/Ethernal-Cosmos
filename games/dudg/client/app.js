// ─── Hub connection bootstrap (same pattern as games/tictactoe/app.js) ────────

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
const defaultHub = window.location.pathname.startsWith('/dudg')
  ? window.location.origin
  : 'https://mea-sama.duckdns.org:12346';

const ETHERNAL = hubFromQuery ?? hubFromSession ?? defaultHub;
sessionStorage.setItem('ec_hub_url', ETHERNAL);

let token = null;
let refreshToken = null;
let myUserId = null;
let myUsername = null;
let socket = null;
let authMode = 'login';

let lobbyId = null;
let isHost = false;
let latestState = null; // last gameState payload from the subprocess (host/contestant/spectator shaped)
let availableQuestions = []; // metadata list from GET /dudg/api/questions
let currentPool = []; // filenames the host has added to this lobby

const els = {};
document.querySelectorAll('[id]').forEach((el) => { els[toCamel(el.id)] = el; });
function toCamel(id) { return id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()); }

function setStatus(msg, cls = '') {
  els.status.textContent = msg;
  els.status.className = cls;
}

function show(name) {
  ['sAuth', 'sLobby', 'sSetup', 'sGame'].forEach((key) => {
    els[key].classList.toggle('hidden', key !== name);
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function switchTab(mode) {
  authMode = mode;
  els.tabLogin.classList.toggle('active', mode === 'login');
  els.tabReg.classList.toggle('active', mode === 'reg');
  els.btnAuth.textContent = mode === 'login' ? 'Anmelden' : 'Registrieren';
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
      els.authErr.textContent = data.error ?? 'Anmeldung fehlgeschlagen.';
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
    window.EthernalPanel?.setContext({ gameTitle: 'Duell um die Geld' });
    setStatus('Verbinde...');
    connectSocket();
  } catch (error) {
    els.authErr.textContent = 'Verbindungsfehler: ' + (error?.message ?? error);
  } finally {
    els.btnAuth.disabled = false;
  }
}

function authHeaders() {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// ─── Socket connection ───────────────────────────────────────────────────────

function connectSocket() {
  socket = io(ETHERNAL, { auth: { token: 'Bearer ' + token, clientType: 'game' }, transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    setStatus('Verbunden', 'ok');
    socket.emit('getLobbyInfo');
    show('sLobby');
    refreshOpenLobbies();
    loadQuestionIndex();
  });

  socket.on('connect_error', (error) => {
    setStatus('Verbindungsfehler: ' + error.message, 'err');
  });

  socket.on('error', (message) => setStatus(message, 'err'));

  socket.on('lobbyCreated', (lobby) => applyLobby(lobby));
  socket.on('lobbyInfo', (lobby) => applyLobby(lobby));
  socket.on('lobbyUpdated', (lobby) => applyLobby(lobby));
  socket.on('lobbyList', (lobbies) => renderOpenLobbies(lobbies));

  socket.on('gameStarting', () => {
    // Subprocess is up — this does NOT mean the round has started yet (still 'setup' phase);
    // screen navigation is driven entirely by latestState.phase in the gameState handler below.
  });

  socket.on('gameState', (state) => {
    latestState = state;
    if (state && state.phase && state.phase !== 'setup') show('sGame');
    else if (state) show('sSetup');
    render();
  });

  socket.on('gameOver', (result) => {
    setStatus('Spiel beendet: ' + (result?.reason ?? result?.winnerId ?? ''), 'warn');
  });

  socket.on('playerKicked', () => {
    setStatus('Du wurdest aus der Lobby entfernt', 'warn');
    show('sLobby');
  });
}

function applyLobby(lobby) {
  lobbyId = lobby.id;
  isHost = lobby.hostId === myUserId;
  els.setupLobbyName.textContent = lobby.name;
  els.inviteCode.textContent = lobby.inviteCode ?? '------';
  renderMemberList(lobby);
  els.setupHostPanel.classList.toggle('hidden', !isHost);
  window.EthernalPanel?.setLobby(lobby.id);
  setupPanelActions();
  const inSetup = !latestState || latestState.phase === 'setup';
  if (lobby.status !== 'closed' && inSetup) show('sSetup');
  else if (lobby.status !== 'closed') show('sGame');
}

function setupPanelActions() {
  window.EthernalPanel?.clearActions();
  window.EthernalPanel?.registerAction({
    id: 'leave',
    label: 'Lobby verlassen',
    icon: '🚪',
    style: 'danger',
    onClick: () => socket.emit('leaveLobby'),
  });
}

function renderMemberList(lobby) {
  els.memberList.innerHTML = lobby.players
    .map((p) => `<div class="member-row">${p.isHost ? '👑' : ''} ${escapeHtml(p.username)}</div>`)
    .join('');
  updateRoleUi();
}

function updateRoleUi() {
  const myRole = latestState?.role;
  els.btnRoleToggle.classList.toggle('hidden', isHost);
  if (isHost) {
    els.roleIndicator.textContent = '';
    return;
  }
  const wantsSpectator = myRole !== 'spectator';
  els.btnRoleToggle.textContent = wantsSpectator ? '🎭 Zuschauer werden' : '🎮 Mitspieler werden';
  els.roleIndicator.textContent = myRole ? `Deine Rolle: ${myRole === 'spectator' ? 'Zuschauer' : 'Mitspieler'}` : '';
}

// ─── Lobby list / create / join ──────────────────────────────────────────────

function refreshOpenLobbies() {
  socket.emit('listLobbies', 'dudg');
}

function renderOpenLobbies(lobbies) {
  if (lobbies.length === 0) {
    els.openLobbyList.innerHTML = '<p class="small">Keine offenen Lobbys.</p>';
    return;
  }
  els.openLobbyList.innerHTML = lobbies
    .map((l) => `<div class="lobby-row"><span>${escapeHtml(l.name)} (${l.players.length})</span><button class="btn" data-join="${l.id}">Beitreten</button></div>`)
    .join('');
  els.openLobbyList.querySelectorAll('[data-join]').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('joinLobby', { lobbyId: btn.dataset.join }));
  });
}

// ─── Question index / pool (setup screen) ────────────────────────────────────

let expandedLabels = new Set();
let questionSearch = '';

async function loadQuestionIndex() {
  try {
    const res = await fetch(ETHERNAL + '/dudg/api/questions', { headers: authHeaders() });
    availableQuestions = await res.json();
    renderLabelCards();
  } catch {
    // ignore — host can retry via the refresh button
  }
}

/** Groups availableQuestions by label; a question with N labels appears in N groups. */
function labelGroups() {
  const byLabel = new Map();
  for (const q of availableQuestions) {
    for (const label of q.labels) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(q);
    }
  }
  return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderLabelCards() {
  const search = questionSearch.trim().toLowerCase();
  const groups = labelGroups();

  els.labelCards.innerHTML = groups
    .map(([label, questions]) => {
      const visible = search ? questions.filter((q) => q.title.toLowerCase().includes(search)) : questions;
      if (search && visible.length === 0) return '';
      const allIn = questions.every((q) => currentPool.includes(q.filename));
      const someIn = !allIn && questions.some((q) => currentPool.includes(q.filename));
      const expanded = expandedLabels.has(label) || !!search;
      const rows = expanded
        ? visible
            .map((q) => {
              const inPool = currentPool.includes(q.filename);
              return `<div class="question-row"><label class="checkbox-row"><input type="checkbox" class="question-cb" data-filename="${escapeHtml(q.filename)}" ${inPool ? 'checked' : ''}> ${escapeHtml(q.title)}</label></div>`;
            })
            .join('')
        : '';
      return `<div class="label-card">` +
        `<div class="label-card-header">` +
        `<label class="checkbox-row"><input type="checkbox" class="label-cb" data-label="${escapeHtml(label)}" ${allIn ? 'checked' : ''} ${someIn ? 'data-indeterminate="1"' : ''}> <strong>${escapeHtml(label)}</strong> (${questions.length})</label>` +
        `<button class="btn" data-expand="${escapeHtml(label)}">${expanded ? '▲ einklappen' : '▼ anzeigen'}</button>` +
        `</div>` +
        `<div class="label-card-body">${rows}</div>` +
        `</div>`;
    })
    .join('');

  els.labelCards.querySelectorAll('.label-cb').forEach((cb) => {
    cb.indeterminate = cb.dataset.indeterminate === '1';
    cb.addEventListener('change', () => {
      const label = cb.dataset.label;
      sendAction(cb.checked ? 'addQuestionsByLabel' : 'removeQuestionsByLabel', { label });
    });
  });
  els.labelCards.querySelectorAll('[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.expand;
      if (expandedLabels.has(label)) expandedLabels.delete(label);
      else expandedLabels.add(label);
      renderLabelCards();
    });
  });
  els.labelCards.querySelectorAll('.question-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const filename = cb.dataset.filename;
      sendAction(cb.checked ? 'addQuestion' : 'removeQuestion', { filename });
    });
  });
}

function renderPoolPreview() {
  els.poolPreview.innerHTML = '<strong>Ausgewählt:</strong> ' + (currentPool.length === 0 ? '(keine)' : currentPool.map((f) => escapeHtml(titleFor(f))).join(', '));
  const options = currentPool.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(titleFor(f))}</option>`).join('');
  els.firstQuestion.innerHTML = options;
  els.nextQuestion.innerHTML = options;
  renderLabelCards();
}

function titleFor(filename) {
  return availableQuestions.find((q) => q.filename === filename)?.title ?? filename;
}

// ─── Custom question dialog ───────────────────────────────────────────────────

let cqMode = 'form';

function openCustomQuestionDialog() {
  els.cqErr.textContent = '';
  els.dlgCustomQuestion.showModal();
}

async function submitCustomQuestion() {
  els.cqErr.textContent = '';
  const labels = els.cqLabels.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (labels.length === 0) labels.push('Custom');
  let body;
  if (cqMode === 'form') {
    if (!els.cqTitle.value.trim()) { els.cqErr.textContent = 'Frage darf nicht leer sein.'; return; }
    body = {
      mode: 'form',
      title: els.cqTitle.value.trim(),
      moderatorNotes: els.cqNotes.value,
      media: els.cqMedia.value,
      hint1: els.cqHint1.value,
      hint2: els.cqHint2.value,
      answer: els.cqAnswer.value,
      options: els.cqOptions.value,
      rank: els.cqRank.value,
      labels,
    };
  } else {
    const file = els.cqFile.files[0];
    if (!file) { els.cqErr.textContent = 'Bitte eine .md Datei wählen.'; return; }
    const rawMarkdown = await file.text();
    body = { mode: 'raw', filename: els.cqFilename.value.trim() || file.name.replace(/\.md$/, ''), rawMarkdown, labels };
  }
  try {
    const res = await fetch(ETHERNAL + '/dudg/api/questions', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { els.cqErr.textContent = data.error?.message ?? JSON.stringify(data.error) ?? 'Fehler beim Speichern.'; return; }
    els.dlgCustomQuestion.close();
    await loadQuestionIndex();
  } catch (err) {
    els.cqErr.textContent = 'Verbindungsfehler: ' + err.message;
  }
}

// ─── gameAction helper ────────────────────────────────────────────────────────

function sendAction(type, payload) {
  socket.emit('gameAction', { type, payload: payload ?? {} });
}

// ─── Rendering (driven by latestState.role) ──────────────────────────────────

const PHASE_LABELS = {
  setup: 'Setup', collecting: 'Antworten sammeln', bid1: 'Wette 1', hint1: 'Hinweis 1',
  bid2: 'Wette 2', hint2: 'Hinweis 2', bid3: 'Wette 3', answer: 'Antwort', bid4: 'Wette 4',
  reveal: 'Auflösung', payout: 'Auszahlung', gameover: 'Spiel beendet',
};

function render() {
  if (!latestState) return;
  els.phaseTrack.textContent = 'Phase: ' + (PHASE_LABELS[latestState.phase] ?? latestState.phase);
  updateRoleUi();

  const role = latestState.role;
  els.viewHost.classList.toggle('hidden', role !== 'host');
  els.viewContestant.classList.toggle('hidden', role !== 'contestant');
  els.viewSpectator.classList.toggle('hidden', role !== 'spectator');

  if (role === 'host') {
    currentPool = latestState.questionPool ?? [];
    renderPoolPreview();
    renderHost();
  } else if (role === 'contestant') {
    renderContestant();
  } else if (role === 'spectator') {
    renderSpectator();
  }
}

function renderQuestionHtml(q, wrapperId) {
  if (!q) return '<p>(keine Frage geladen)</p>';
  return `${q.questionHtml ?? `<p>${escapeHtml(q.questionText ?? '')}</p>`}` +
    (q.mediaHtml ?? '') +
    (q.hint1Html ? `<div class="hint">💡 ${q.hint1Html}</div>` : '') +
    (q.hint2Html ? `<div class="hint">💡 ${q.hint2Html}</div>` : '') +
    (q.answerHtml ? `<div class="answer-reveal">✅ ${q.answerHtml}</div>` : '');
}

function renderHost() {
  const s = latestState;
  els.hostQuestion.innerHTML = renderQuestionHtml(s.currentQuestion);
  els.hostPlayers.innerHTML = (s.players ?? [])
    .map((p) => `<div class="player-row ${p.userId === s.currentBettorId ? 'active-turn' : ''} ${p.folded ? 'folded' : ''} ${p.eliminated ? 'eliminated' : ''}">` +
      `<span>${p.connected ? '🟢' : '🔴'} ${escapeHtml(p.username)}</span>` +
      `<span>💰 ${p.chips}</span><span>Bet: ${p.currentBet}</span>` +
      (p.answer !== null ? `<span>Antwort: ${escapeHtml(String(p.answer))}</span>` : '') +
      `</div>`)
    .join('');

  els.hostSb.value = s.sbAmount;
  els.hostBb.value = s.bbAmount;

  const jokerPending = !!s.jokerActiveUserId && !s.jokerAnswer;
  els.jokerPanel.classList.toggle('hidden', !jokerPending);
  if (jokerPending) {
    els.jokerRequestInfo.textContent = `${s.jokerActiveUsername} bittet um eine Joker-Antwort.`;
  }

  els.payoutPanel.innerHTML = (s.players ?? [])
    .filter((p) => !p.folded && !p.eliminated)
    .map((p) => `<label class="checkbox-row"><input type="checkbox" class="winner-cb" value="${p.userId}"> ${escapeHtml(p.username)}</label>`)
    .join('') + '<button class="btn btn-gold" id="btn-payout">Auszahlen</button>';
  document.getElementById('btn-payout')?.addEventListener('click', () => {
    const winnerIds = [...els.payoutPanel.querySelectorAll('.winner-cb:checked')].map((cb) => cb.value);
    if (winnerIds.length > 0) sendAction('payout', { winnerIds });
  });
}

function renderContestant() {
  const s = latestState;
  els.contestantBar.innerHTML = `💰 ${s.chips} &nbsp; | &nbsp; Pot: ${s.pot} &nbsp; | &nbsp; Einsatz: ${s.currentBet} &nbsp; | &nbsp; SB/BB: ${s.sbAmount}/${s.bbAmount}`;
  els.contestantQuestion.innerHTML = renderQuestionHtml(s.question);

  if (s.phase === 'collecting' && !s.answerLocked && !s.eliminated) {
    els.contestantAnswerBox.innerHTML = s.question?.questionType === 'options'
      ? (s.question.options ?? []).map((o) => `<button class="btn option-btn" data-opt="${o.letter}">${o.letter}: ${o.html}</button>`).join('')
      : `<input id="answer-input" type="text" value="${escapeHtml(s.answer ?? '')}"><button class="btn btn-gold" id="btn-submit-answer">Antwort senden</button>`;
    els.contestantAnswerBox.querySelectorAll('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => sendAction('submitAnswer', { answer: btn.dataset.opt }));
    });
    document.getElementById('btn-submit-answer')?.addEventListener('click', () => {
      sendAction('submitAnswer', { answer: document.getElementById('answer-input').value });
    });
  } else {
    els.contestantAnswerBox.innerHTML = `<p>Deine Antwort: <strong>${escapeHtml(s.answer || '(keine)')}</strong> ${s.answerLocked ? '🔒' : ''}</p>`;
  }

  els.btnUseJoker.classList.toggle('hidden', !s.jokerEnabled || s.jokerUsed || s.phase !== 'collecting');
  if (s.jokerPendingForMe) els.jokerStatus.textContent = 'Joker wurde angefragt — wartet auf Antwort des Hosts...';
  else if (s.jokerAnsweredForMe) els.jokerStatus.textContent = `Joker hat für dich geantwortet${s.jokerNote ? ': ' + escapeHtml(s.jokerNote) : ''}.`;
  else els.jokerStatus.textContent = '';

  const canBet = s.isCurrentBettor && s.phase.startsWith('bid');
  els.bettingControls.classList.toggle('hidden', !canBet);
  els.contestantTurnMsg.textContent = s.eliminated ? 'Du bist ausgeschieden.' : canBet ? 'Du bist am Zug!' : s.phase.startsWith('bid') ? 'Warte auf andere Spieler...' : '';
}

function renderSpectator() {
  const s = latestState;
  els.displayQuestion.innerHTML = renderQuestionHtml(s.question);
  els.displayPlayers.innerHTML = (s.players ?? [])
    .map((p) => `<div class="player-row ${p.folded ? 'folded' : ''} ${p.eliminated ? 'eliminated' : ''}">` +
      `<span>${escapeHtml(p.username)}</span><span>💰 ${p.chips}</span><span>Bet: ${p.currentBet}</span>` +
      (p.answer !== null ? `<span>Antwort: ${escapeHtml(String(p.answer))}</span>` : '') + `</div>`)
    .join('') + `<p>Pot: ${s.pot}</p>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

els.tabLogin.addEventListener('click', () => switchTab('login'));
els.tabReg.addEventListener('click', () => switchTab('reg'));
els.btnAuth.addEventListener('click', doAuth);

els.btnCreate.addEventListener('click', () => {
  socket.emit('createLobby', { gameId: 'dudg', name: (myUsername ?? 'Spieler') + 's Runde', isPrivate: true, settings: {} });
});
els.btnJoin.addEventListener('click', () => {
  const code = els.codeIn.value.trim();
  if (code) socket.emit('joinLobbyByCode', { code });
});

els.btnLeaveSetup.addEventListener('click', () => { socket.emit('leaveLobby'); show('sLobby'); });
els.btnLeaveGame.addEventListener('click', () => { socket.emit('leaveLobby'); show('sLobby'); });

els.btnRoleToggle.addEventListener('click', () => {
  const wantsSpectator = latestState?.role !== 'spectator';
  sendAction('setRole', { role: wantsSpectator ? 'spectator' : 'contestant' });
});

els.btnRefreshQuestions.addEventListener('click', () => { loadQuestionIndex(); sendAction('refreshQuestions'); });
els.questionSearch.addEventListener('input', () => { questionSearch = els.questionSearch.value; renderLabelCards(); });
els.btnAddCustom.addEventListener('click', openCustomQuestionDialog);
els.btnCqCancel.addEventListener('click', () => els.dlgCustomQuestion.close());
els.btnCqSubmit.addEventListener('click', submitCustomQuestion);
els.cqTabForm.addEventListener('click', () => { cqMode = 'form'; els.cqTabForm.classList.add('active'); els.cqTabRaw.classList.remove('active'); els.cqForm.classList.remove('hidden'); els.cqRaw.classList.add('hidden'); });
els.cqTabRaw.addEventListener('click', () => { cqMode = 'raw'; els.cqTabRaw.classList.add('active'); els.cqTabForm.classList.remove('active'); els.cqRaw.classList.remove('hidden'); els.cqForm.classList.add('hidden'); });

els.btnStartGame.addEventListener('click', () => {
  sendAction('startGame', {
    questionFile: els.firstQuestion.value,
    startingChips: Number(els.cfgChips.value) || 1000,
    sbAmount: Number(els.cfgSb.value) || 25,
    bbAmount: Number(els.cfgBb.value) || 50,
    jokerEnabled: els.cfgJoker.checked,
  });
});

els.btnLockAnswers.addEventListener('click', () => sendAction('lockAnswers'));
els.btnAdvancePhase.addEventListener('click', () => sendAction('advancePhase'));
els.btnSkipTurn.addEventListener('click', () => sendAction('skipTurn'));
els.btnPlayAudio.addEventListener('click', () => sendAction('playAudio'));
els.btnSetSbbb.addEventListener('click', () => sendAction('setSBBB', { sb: Number(els.hostSb.value), bb: Number(els.hostBb.value) }));
els.btnAdvanceDealer.addEventListener('click', () => sendAction('advanceDealer'));
els.btnJokerAnswer.addEventListener('click', () => sendAction('jokerAnswer', { answer: els.jokerAnswerInput.value, note: els.jokerNoteInput.value || null }));
els.btnNextRound.addEventListener('click', () => sendAction('nextRound', { questionFile: els.nextQuestion.value }));
els.btnResetGame.addEventListener('click', () => sendAction('resetGame'));
els.dlgCustomQuestion?.addEventListener('click', (e) => { if (e.target === els.dlgCustomQuestion) els.dlgCustomQuestion.close(); });

els.btnFold.addEventListener('click', () => sendAction('fold'));
els.btnCall.addEventListener('click', () => sendAction('call'));
els.btnRaise.addEventListener('click', () => sendAction('raise', { totalBet: Number(els.raiseAmount.value) }));
els.btnAllin.addEventListener('click', () => sendAction('allIn'));
els.btnUseJoker.addEventListener('click', () => sendAction('useJoker'));

// ─── Auto-login from a previous session ──────────────────────────────────────

(function tryResume() {
  const savedToken = sessionStorage.getItem('ec_token');
  const savedUser = sessionStorage.getItem('ec_user');
  const savedUserId = sessionStorage.getItem('ec_userId');
  if (savedToken && savedUser && savedUserId) {
    token = savedToken;
    myUsername = savedUser;
    myUserId = savedUserId;
    setStatus('Verbinde...');
    connectSocket();
  } else {
    show('sAuth');
  }
})();
