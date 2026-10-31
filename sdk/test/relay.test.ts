import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../src';
import { startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, rejectsWith, sleep } from './helpers';

let hub: TestHub;
let fleet: Fleet;
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  await fleet?.closeAll();
});

async function trio() {
  fleet = new Fleet(hub);
  const a = await fleet.player('other');
  const b = await fleet.player('other');
  const c = await fleet.player('other');
  const lobby = await a.client.createLobby({ name: 'relay' });
  await b.client.joinLobby(lobby.id);
  await c.client.joinLobby(lobby.id);
  return { a, b, c, lobby };
}

describe('relay: text messages', () => {
  it('sendToLobby reaches everyone but the sender, with increasing seq; echo also reaches the sender', async () => {
    const { a, b, c } = await trio();
    await a.client.sendToLobby('chat', { text: 'one' });
    await a.client.sendToLobby('chat', { text: 'two' });
    const first = (await b.rec.waitFor('message', (m: any) => m.payload.text === 'one'))[0];
    const second = (await b.rec.waitFor('message', (m: any) => m.payload.text === 'two'))[0];
    expect(first).toMatchObject({ from: a.userId, type: 'chat', payload: { text: 'one' }, seq: expect.any(Number) });
    expect(second.seq).toBeGreaterThan(first.seq);
    await c.rec.waitFor('message', (m: any) => m.payload.text === 'two');
    await sleep(100);
    expect(a.rec.count('message', (m: any) => m.from === a.userId)).toBe(0);

    await a.client.sendToLobby('chat', { text: 'echoed' }, { echo: true });
    expect((await a.rec.waitFor('message', (m: any) => m.payload.text === 'echoed'))[0].from).toBe(a.userId);
  });

  it('sendToPlayer reaches only the target; targeting yourself needs echo', async () => {
    const { a, b, c } = await trio();
    await a.client.sendToPlayer(b.userId, 'whisper', [1, 2, 3]);
    expect((await b.rec.waitFor('message', (m: any) => m.type === 'whisper'))[0]).toMatchObject({ from: a.userId, payload: [1, 2, 3] });
    await sleep(150);
    expect(c.rec.count('message', (m: any) => m.type === 'whisper')).toBe(0);
    expect((await rejectsWith(a.client.sendToPlayer(a.userId, 'self', 1))).code).toBe(ErrorCode.CannotTargetSelf);
    await a.client.sendToPlayer(a.userId, 'self', 1, { echo: true });
    await a.rec.waitFor('message', (m: any) => m.type === 'self');
  });

  it('onMessage / onceMessage subscribe with typed payloads', async () => {
    const { a, b } = await trio();
    const seen: Array<{ n: number }> = [];
    const once: Array<{ n: number }> = [];
    b.client.onMessage<{ n: number }>((m) => seen.push(m.payload));
    b.client.onceMessage<{ n: number }>((m) => once.push(m.payload));
    await a.client.sendToLobby('tick', { n: 1 });
    await a.client.sendToLobby('tick', { n: 2 });
    await b.rec.waitFor('message', (m: any) => m.payload.n === 2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(once).toEqual([{ n: 1 }]);
  });

  it('validation and membership errors', async () => {
    const { a, b } = await trio();
    expect((await rejectsWith(a.client.sendToLobby('bad type!', 1))).code).toBe(ErrorCode.InvalidMessageType);
    expect((await rejectsWith(a.client.sendToLobby('big', 'x'.repeat(40_000)))).code).toBe(ErrorCode.PayloadTooLarge);
    expect((await rejectsWith(a.client.sendToPlayer('nobody', 'x', 1))).code).toBe(ErrorCode.PlayerNotInLobby);
    const loner = await fleet.player('other');
    expect((await rejectsWith(loner.client.sendToLobby('x', 1))).code).toBe(ErrorCode.NotInLobby);
    expect((await rejectsWith(loner.client.sendToPlayer(b.userId, 'x', 1))).code).toBe(ErrorCode.NotInLobby);
  });
});

describe('relay: binary messages', () => {
  it('sendToLobbyBinary / sendToPlayerBinary deliver bytes + typeCode; ArrayBuffer input; echo', async () => {
    const { a, b, c } = await trio();
    const got: number[] = [];
    b.client.onBinaryMessage((m) => got.push(m.typeCode));
    const once: number[] = [];
    b.client.onceBinaryMessage((m) => once.push(m.typeCode));

    await a.client.sendToLobbyBinary(7, new Uint8Array([1, 2, 3, 4]));
    const m1 = (await b.rec.waitFor('messageBinary', (m: any) => m.typeCode === 7))[0];
    expect(m1.from).toBe(a.userId);
    expect(Array.from(new Uint8Array(m1.payload))).toEqual([1, 2, 3, 4]);
    expect(m1.seq).toEqual(expect.any(Number));

    const buf = new Uint8Array([9, 8, 7]).buffer;
    await a.client.sendToPlayerBinary(b.userId, 8, buf);
    const m2 = (await b.rec.waitFor('messageBinary', (m: any) => m.typeCode === 8))[0];
    expect(Array.from(new Uint8Array(m2.payload))).toEqual([9, 8, 7]);
    await sleep(150);
    expect(c.rec.count('messageBinary', (m: any) => m.typeCode === 8)).toBe(0);
    expect(got).toEqual([7, 8]);
    expect(once).toEqual([7]);

    await a.client.sendToLobbyBinary(9, new Uint8Array([5]), { echo: true });
    await a.rec.waitFor('messageBinary', (m: any) => m.typeCode === 9);
    await a.client.sendToPlayerBinary(a.userId, 10, new Uint8Array([6]), { echo: true });
    await a.rec.waitFor('messageBinary', (m: any) => m.typeCode === 10);
    expect((await rejectsWith(a.client.sendToPlayerBinary(a.userId, 11, new Uint8Array([6])))).code).toBe(ErrorCode.CannotTargetSelf);
  });

  it('typeCode and size are validated', async () => {
    const { a } = await trio();
    expect((await rejectsWith(a.client.sendToLobbyBinary(70_000, new Uint8Array([1])))).code).toBe(ErrorCode.InvalidBinaryTypecode);
    expect((await rejectsWith(a.client.sendToLobbyBinary(1, new Uint8Array(5000)))).code).toBe(ErrorCode.BinaryPayloadTooLarge);
  });
});
