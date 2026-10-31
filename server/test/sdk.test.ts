import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EthernalClient, EthernalError } from '../../sdk/src/index';
import { startHub, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

const name = () => `sdk${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

describe('Node SDK nutzt die P0-Server-API', () => {
  it('registerGame -> createLobby -> Fehlercodes -> Daten', async () => {
    const a = new EthernalClient({ serverUrl: hub.url });
    const b = new EthernalClient({ serverUrl: hub.url });
    await a.register(name(), 'password123');
    await b.register(name(), 'password123');
    await new Promise((r) => setTimeout(r, 300));

    await expect(a.createLobby({ name: 'x' })).rejects.toMatchObject({ code: 'GAME_NOT_REGISTERED' });
    await a.registerGame('relay');
    await b.registerGame('other');

    const lobby = await a.createLobby({ name: 'L' });
    expect(lobby.gameId).toBe('relay');
    await expect(b.joinLobby(lobby.id)).rejects.toMatchObject({ code: 'GAME_MISMATCH' });
    expect(await b.listLobbies()).toEqual([]);
    expect((await a.getSessionState()).lobby?.id).toBe(lobby.id);

    await a.setUserData('relay', 'k', 1);
    expect((await a.getUserData('relay')).map((e) => e.key)).toContain('k');
    await expect(a.setUserData('nope', 'k', 1)).rejects.toBeInstanceOf(EthernalError);

    await a.leaveLobby();
    await a.logout();
    await b.logout();
  });
});
