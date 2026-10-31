import { describe, expect, it } from 'vitest';
import * as sdk from '../src';
import {
  ErrorCode,
  LobbyChangeReason,
  LobbyStatus,
  type LobbyChangeReason as LobbyChangeReasonT,
  type LobbyStatus as LobbyStatusT,
} from '../src';

const ENUMS = [
  'LobbyStatus', 'LobbyChangeReason', 'LobbyServerStatus', 'ServerSupport', 'LobbyAssignReason', 'LobbyClosedReason',
  'PlayerLeftReason', 'SessionReplacedReason', 'JoinRequestRejectReason', 'JoinRequestWithdrawReason', 'DataVisibility',
  'DataWriteScope', 'FriendRequestSource', 'FriendRequestResult', 'OwnPresenceStatus', 'FriendPresenceStatus',
  'LobbyInviteCancelReason', 'NotificationType', 'ErrorCode',
] as const;

describe('exported wire enums', () => {
  it('are exported as frozen-shape const objects whose values are unique wire strings', () => {
    for (const name of ENUMS) {
      const obj = (sdk as Record<string, unknown>)[name] as Record<string, string>;
      expect(obj, name).toBeTypeOf('object');
      const values = Object.values(obj);
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
      for (const v of values) expect(v, name).toBeTypeOf('string');
    }
  });

  it('keep their documented wire values', () => {
    expect(LobbyChangeReason.ServerRebound).toBe('server_rebound');
    expect(LobbyChangeReason.PlayerJoined).toBe('player_joined');
    expect(LobbyStatus.InProgress).toBe('in_progress');
    expect(ErrorCode.AuthExpired).toBe('AUTH_EXPIRED');
    expect(ErrorCode.LobbyFull).toBe('LOBBY_FULL');
    expect(sdk.NotificationType.FriendOnline).toBe('friend_online');
    expect(sdk.DataVisibility.Public).toBe('public');
  });

  it('work as value and type', () => {
    const reason: LobbyChangeReasonT = LobbyChangeReason.Kicked;
    const status: LobbyStatusT = LobbyStatus.Open;
    expect([reason, status]).toEqual(['kicked', 'open']);
  });
});
