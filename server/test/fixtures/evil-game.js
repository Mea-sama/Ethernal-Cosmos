// Böswilliger Game-Subprocess für Sicherheitstests: reagiert auf PLAYER_ACTION mit gezieltem Fehlverhalten.
const send = (m) => process.send(m);
send({ type: 'READY' });
process.on('message', (msg) => {
  if (msg.type !== 'PLAYER_ACTION') return;
  const { action, data, userId } = msg.payload;
  switch (action) {
    case 'env':
      send({ type: 'GAME_EVENT', payload: { type: 'env', keys: Object.keys(process.env), jwt: process.env.JWT_SECRET ?? null, admin: process.env.ADMIN_TOKEN ?? null, settings: process.env.LOBBY_SETTINGS ?? null } });
      break;
    case 'flood':
      for (let i = 0; i < 20000; i++) { process.stdout.write('F'.repeat(512) + '\n'); process.stderr.write('E'.repeat(512) + '\n'); }
      send({ type: 'GAME_EVENT', payload: { type: 'flooded' } });
      break;
    case 'ipcflood':
      for (let i = 0; i < 5000; i++) send({ type: 'GAME_EVENT', payload: { type: 'spam', i } });
      send({ type: 'GAME_EVENT', payload: { type: 'spam-done' } });
      break;
    case 'badmeta':
      send({ type: 'SAVE_META' });
      send({ type: 'SAVE_META', payload: null });
      send({ type: 'SAVE_META', payload: { userId, gameId: 'evil', entries: 'nope' } });
      send({ type: 'SAVE_META', payload: { userId, gameId: 'evil', entries: [null, 5, { key: 1 }] } });
      send({ type: 'SAVE_META', payload: { userId, gameId: 'evil', entries: [{ key: 'x'.repeat(500), value: 1 }] } });
      send({ type: 'SAVE_META', payload: { userId, gameId: 'evil', entries: [{ key: 'big', value: 'x'.repeat(100000) }] } });
      send({ type: 'SAVE_META', payload: { userId: 'someone-else', gameId: 'evil', entries: [{ key: 'steal', value: 1 }] } });
      send({ type: 'SAVE_META', payload: { userId, gameId: 'fake', entries: [{ key: 'cross', value: 1 }] } });
      send({ type: 'GAME_EVENT', payload: { type: 'badmeta-done' } });
      break;
    case 'badmsg':
      send({ type: 'NOPE', payload: 1 });
      send({ type: 'GET_USER_DATA' });
      send({ type: 'GAME_STATE_FOR_USER' });
      send({ type: 'GAME_EVENT', payload: { type: 'badmsg-done' } });
      break;
    case 'exit':
      process.exit(data?.code ?? 1);
      break;
  }
});
setInterval(() => {}, 1 << 30);
