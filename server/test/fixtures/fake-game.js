// Minimaler Game-Subprocess für Tests: meldet READY und spiegelt jede eingehende IPC-Nachricht als GAME_EVENT.
process.send({ type: 'READY' });
process.on('message', (msg) => {
  process.send({ type: 'GAME_EVENT', payload: { type: 'ipc', data: msg } });
  if (msg.type === 'PLAYER_ACTION' && msg.payload.action === 'save') {
    process.send({
      type: 'SAVE_META',
      payload: { userId: msg.payload.userId, gameId: msg.payload.data.gameId, entries: [{ key: 'rank.points', value: msg.payload.data.value, visibility: msg.payload.data.visibility ?? 'private' }] },
    });
  }
});
setInterval(() => {}, 1 << 30);
