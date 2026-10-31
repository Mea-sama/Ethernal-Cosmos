// Minimal hub game subprocess for the C# SDK tests: reports READY and turns PLAYER_ACTIONs into game events.
process.send({ type: 'READY' });
process.on('message', (msg) => {
  if (msg.type !== 'PLAYER_ACTION') return;
  const { userId, action, data } = msg.payload;
  switch (action) {
    case 'event':
      process.send({ type: 'GAME_EVENT', payload: { from: userId, data } });
      break;
    case 'state':
      process.send({ type: 'GAME_STATE', payload: { round: data } });
      break;
    case 'stateForMe':
      process.send({ type: 'GAME_STATE_FOR_USER', payload: { userId, state: { secret: data } } });
      break;
    case 'over':
      process.send({ type: 'GAME_OVER', payload: { winner: userId } });
      break;
    case 'save':
      process.send({
        type: 'SAVE_META',
        payload: { userId, gameId: 'echo', entries: [{ key: 'rank.points', value: data, visibility: 'public' }] },
      });
      break;
  }
});
setInterval(() => {}, 1 << 30);
