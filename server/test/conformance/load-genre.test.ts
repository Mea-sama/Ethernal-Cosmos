import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { befriend, closeAll, gameServer, live, sleep, startHub, type TestClient, type TestHub } from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub({ env: { FRIEND_NAME_LOOKUP_MIN_MS: '20', SOCIAL_PURGE_INTERVAL_MS: '300' } }); });
afterAll(async () => { await hub.stop(); });

const until = async (pred: () => boolean, ms = 10000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
};

describe('Load smoke', () => {
  it('TEST-LOAD-01: 60 clients connect, register a game, form lobbies and relay 240 messages without errors', async () => {
    const t0 = Date.now();
    const clients = await Promise.all(Array.from({ length: 60 }, () => live(hub, 'relay')));
    const pairs: Array<[TestClient, TestClient]> = [];
    for (let i = 0; i < clients.length; i += 2) pairs.push([clients[i], clients[i + 1]]);
    await Promise.all(pairs.map(async ([a, b], i) => {
      const { lobby } = await a.emitAck('createLobby', { name: `load-${i}` });
      expect((await b.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    }));
    const results = await Promise.all(clients.flatMap((c) => Array.from({ length: 4 }, (_, n) => c.emitAck('sendToLobby', { type: 'load', payload: n }))));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    await until(() => clients.every((c) => c.count('message', (m) => m.type === 'load') === 4));
    expect(clients.reduce((n, c) => n + c.count('message', (m) => m.type === 'load'), 0)).toBe(240);
    expect(clients.flatMap((c) => c.events.filter((e) => e.event === 'error' || e.event === 'connect_error'))).toEqual([]);
    expect((await fetch(`${hub.url}/health`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(30000);
    closeAll(...clients);
  }, 60000);
});

describe('Genre scenarios', () => {
  it('TEST-GENRE-01: turn-based — host-relayed turns alternate between two players with ordered delivery', async () => {
    const [host, guest] = [await live(hub, 'relay'), await live(hub, 'relay')];
    const { lobby } = await host.emitAck('createLobby', { name: 'chess' });
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await host.emitAck('sendToLobby', { type: 'turn', payload: { turn: 0, player: host.user.userId, move: 'e4' } });
    for (let turn = 1; turn <= 6; turn++) {
      const mover = turn % 2 ? guest : host;
      const prev = await mover.waitFor('message', (m) => m.type === 'turn' && m.payload.turn === turn - 1);
      expect(prev.payload.player).toBe(turn % 2 ? host.user.userId : guest.user.userId);
      await mover.emitAck('sendToLobby', { type: 'turn', payload: { turn, player: mover.user.userId, move: `m${turn}` } });
    }
    await host.waitFor('message', (m) => m.payload.turn === 5);
    await sleep(100);
    const seqs = guest.events.filter((e) => e.event === 'message').map((e) => e.args[0].seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    closeAll(host, guest);
  });

  it('TEST-GENRE-02: realtime/shooter — high-rate JSON and binary relay arrive complete and in order', async () => {
    const [a, b] = [await live(hub, 'relay'), await live(hub, 'relay')];
    const { lobby } = await a.emitAck('createLobby', { name: 'arena' });
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    const N = 300;
    const sends: Array<Promise<any>> = [];
    for (let i = 0; i < N; i++) {
      sends.push(a.emitAck('sendToLobby', { type: 'pos', payload: { i, x: i * 0.5 } }));
      if (i % 3 === 0) sends.push(a.emitAck('sendToLobbyBinary', { typeCode: 7, payload: new Uint8Array([i & 255, 1, 2, 3]) }));
    }
    expect((await Promise.all(sends)).filter((r) => !r.ok)).toEqual([]);
    await until(() => b.count('message', (m) => m.type === 'pos') === N && b.count('messageBinary') === N / 3);
    const order = b.events.filter((e) => e.event === 'message' && e.args[0].type === 'pos').map((e) => e.args[0].payload.i);
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
    const bin = b.events.find((e) => e.event === 'messageBinary')!.args[0];
    expect(bin.typeCode).toBe(7);
    expect(Array.from(new Uint8Array(bin.payload))).toEqual([0, 1, 2, 3]);
    closeAll(a, b);
  });

  it('TEST-GENRE-03: co-op with game server — server owns state, players act, state and results flow back', async () => {
    const s = await gameServer(hub, 'gs-req');
    const [p1, p2] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const { lobby } = await p1.emitAck('createLobby', { name: 'raid' });
    await p2.emitAck('joinLobby', { lobbyId: lobby.id });
    await s.waitFor('player:joined', (d) => d.userId === p2.user.userId);
    let hp = 100;
    for (const [p, dmg] of [[p1, 30], [p2, 30], [p1, 40]] as const) {
      await p.emitAck('gameAction', { type: 'attack', payload: { dmg } });
      const act = await s.waitFor('player:action', (d) => d.userId === p.user.userId && d.payload.dmg === dmg);
      hp -= act.payload.dmg;
      await s.emitAck('lobby:state', { lobbyId: lobby.id, state: { bossHp: hp } });
      expect(await p1.waitFor('gameState', (st) => st.bossHp === hp)).toEqual({ bossHp: hp });
      await p2.waitFor('gameState', (st) => st.bossHp === hp);
    }
    expect(hp).toBe(0);
    await s.emitAck('lobby:gameOver', { lobbyId: lobby.id, result: { victory: true } });
    expect(await p1.waitFor('gameOver')).toEqual({ victory: true });
    expect(await p2.waitFor('gameOver')).toEqual({ victory: true });
    closeAll(p1, p2, s);
  });

  it('TEST-GENRE-04: lobby + social flow — meet in a lobby, befriend, DM, invite a third friend, who joins', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    const { lobby } = await a.emitAck('createLobby', { name: 'party', isPrivate: true });
    await befriend(a, b);
    await befriend(a, c);
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'join my party' })).ok).toBe(true);
    expect((await b.waitFor('dm:received', (m) => m.text === 'join my party')).from).toBe(a.user.userId);
    const { invite } = await a.emitAck('lobby:invite', { friendId: b.user.userId });
    expect((await b.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).lobby.id).toBe(lobby.id);
    const inv2 = await a.emitAck('lobby:invite', { friendId: c.user.userId });
    expect((await c.emitAck('lobby:acceptInvite', { inviteId: inv2.invite.inviteId })).lobby.players).toHaveLength(3);
    await a.emitAck('sendToLobby', { type: 'gg', payload: 1 });
    await b.waitFor('message', (m) => m.type === 'gg');
    await c.waitFor('message', (m) => m.type === 'gg');
    closeAll(a, b, c);
  });
});
