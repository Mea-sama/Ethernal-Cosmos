import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as shared from '@ethernal/shared';

const root = path.resolve(__dirname, '../..');

describe('Wire enums', () => {
  it('generated C# enums and docs/enums.md are up to date', () => {
    expect(() => execFileSync('node', ['scripts/gen-csharp-enums.mjs', '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('exports keep wire value = lowercase snake_case (or SCREAMING_CASE for codes/results)', () => {
    for (const name of ['LobbyChangeReason', 'LobbyAssignReason', 'LobbyServerStatus', 'ErrorCode', 'FriendRequestResult'] as const) {
      const values = Object.values(shared[name]) as string[];
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }
    expect(shared.LobbyChangeReason.ServerRebound).toBe('server_rebound');
    expect(shared.LobbyAssignReason.ServerRebound).toBe('server_rebound');
    expect(shared.ErrorCode.NoGameServerAvailable).toBe('NO_GAME_SERVER_AVAILABLE');
  });
});
