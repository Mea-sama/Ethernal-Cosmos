import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { EthernalClient, GameServerClient } from '../src';

// Internal helpers that live on the prototype but are not public API.
const INTERNAL = new Set(['constructor', 'connectSocket', 'getSocket', 'call', 'joinRequestRace', 'abortJoinRace', 'storeTokens', 'doRefresh', 'authedFetch', 'post', 'reset', 'abort', 'decide']);

const methodsOf = (cls: { prototype: object }) =>
  Object.getOwnPropertyNames(cls.prototype)
    .filter((n) => !INTERNAL.has(n) && typeof (cls.prototype as any)[n] === 'function')
    .sort();
const publicMethods = methodsOf(EthernalClient);
const gameServerMethods = methodsOf(GameServerClient);

const testDir = __dirname;
const testSources = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts') && f !== 'api-coverage.test.ts')
  .map((f) => readFileSync(path.join(testDir, f), 'utf8'))
  .join('\n');
const docs = readFileSync(path.join(__dirname, '../../docs/sdk-nodejs.md'), 'utf8');
const eventsSrc = readFileSync(path.join(__dirname, '../../shared/src/types/events.ts'), 'utf8');

const gsSrc = readFileSync(path.join(__dirname, '../../shared/src/types/gameserver.ts'), 'utf8');
const gameServerEvents = (() => {
  const block = /interface HubToGameServerEvents \{([\s\S]*?)\n\}/.exec(gsSrc)?.[1] ?? '';
  return [...block.matchAll(/^\s*'?([A-Za-z:]+)'?\s*:/gm)].map((m) => m[1]);
})();

const serverEvents = (() => {
  const block = /interface ServerToClientEvents \{([\s\S]*?)\n\}/.exec(eventsSrc)?.[1] ?? '';
  return [...block.matchAll(/^\s*'?([A-Za-z:]+)'?\s*:/gm)].map((m) => (m[1] === 'error' ? 'serverError' : m[1])); // the SDK renames `error` to avoid EventEmitter's built-in
})();

const mentions = (haystack: string, name: string) => new RegExp(`\\b${name}\\b`).test(haystack);

describe('EthernalClient API coverage', () => {
  it('finds a plausible public API surface', () => {
    expect(publicMethods.length).toBeGreaterThan(50);
    expect(publicMethods).toContain('registerGame');
    expect(publicMethods).not.toContain('post');
  });

  it('every public method is exercised in at least one sdk test', () => {
    const untested = publicMethods.filter((m) => !mentions(testSources, m));
    expect(untested, `add tests for: ${untested.join(', ')}`).toEqual([]);
  });

  it('every public method is documented in docs/sdk-nodejs.md', () => {
    const undocumented = publicMethods.filter((m) => !mentions(docs, m));
    expect(undocumented, `document in docs/sdk-nodejs.md: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('every server-to-client event is tested and documented', () => {
    expect(serverEvents.length).toBeGreaterThan(20);
    const quoted = (src: string, e: string) => src.includes(`'${e}'`) || src.includes(`\`${e}\``);
    const untested = serverEvents.filter((e) => !quoted(testSources, e) && !testSources.includes(`"${e}"`));
    const undocumented = serverEvents.filter((e) => !docs.includes(`\`${e}\``));
    expect(untested, `events without tests: ${untested.join(', ')}`).toEqual([]);
    expect(undocumented, `events missing in docs: ${undocumented.join(', ')}`).toEqual([]);
  });
});

describe('GameServerClient API coverage', () => {
  const gsTests = readFileSync(path.join(testDir, 'gameserver.test.ts'), 'utf8');
  const gsDocs = docs.slice(docs.indexOf('## GameServerClient'));

  it('finds a plausible public API surface', () => {
    expect(gameServerMethods).toEqual(expect.arrayContaining(['connect', 'sendToLobby', 'kickPlayer', 'incrementUserData', 'drain']));
    expect(gameServerEvents).toEqual(expect.arrayContaining(['lobby:assigned', 'player:action']));
  });

  it('every public method is exercised in gameserver.test.ts and documented', () => {
    expect(gameServerMethods.filter((m) => !mentions(gsTests, m)), 'untested').toEqual([]);
    expect(gameServerMethods.filter((m) => !mentions(gsDocs, m)), 'undocumented').toEqual([]);
  });

  it('every hub-to-server event is tested and documented', () => {
    const quoted = (src: string, e: string) => src.includes(`'${e}'`);
    expect(gameServerEvents.filter((e) => !quoted(gsTests, e)), 'untested').toEqual([]);
    expect(gameServerEvents.filter((e) => !gsDocs.includes(`\`${e}\``)), 'undocumented').toEqual([]);
  });
});
