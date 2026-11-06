# Score Rush 2P (Raylib + Authoritative C# Game Server)

This mini game is a two-player proof-of-integration for Ethernal Cosmos:
- Raylib client app for manual play and SDK workflow testing
- Authoritative C# game server using GameServerClient
- Required game-server binding (`serverSupport: required`)
- Public leaderboard key (`round.best_score`) for best single-round score

## Projects

- `csharp-sdk/EthernalCosmos.ScoreRush.Client`
- `csharp-sdk/EthernalCosmos.ScoreRush.Server`
- Shared contracts file:
  - `csharp-sdk/EthernalCosmos.ScoreRush.Shared/ScoreRushContracts.cs`

## Implemented behavior

- Arena with borders, player circles, and collectible points
- Round timer with winner-by-score logic
- 20 pickups at round start, then 2 pickups per second
- Server-authoritative movement and scoring
- Mid-round leave handling as forfeit
- Disconnect/reconnect aware state (player presence changes)
- Server rebound awareness (`server_rebound` assignment accepted and round restarted)
- Lobby operations in client UI:
  - create/join/leave
  - lock/unlock
  - request join by code
  - host responds to join requests
  - transfer host
  - kick/unkick
  - simulate disconnect
- Leaderboard query for best round score

## Build

```powershell
# from repo root
dotnet build csharp-sdk/EthernalCosmos.slnx
```

## Prerequisites for manual run

1. Hub server running (and game id available in registry):
   - `score-rush-2p` is registered in `server/src/games/external-games.ts`.
2. A valid game-server key for `score-rush-2p`.

Create/list keys through admin API (requires `ADMIN_TOKEN` configured on hub):

```powershell
# example create key (adjust URL/token)
$token = "admin-test"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:12346/admin/game-servers/score-rush-2p/keys" -Headers @{ Authorization = "Bearer $token" }
```

## Run order

1. Start hub server.
2. Start Score Rush authoritative game server.
3. Start one or two Score Rush clients.

```powershell
# terminal 1: game server
dotnet run --project csharp-sdk/EthernalCosmos.ScoreRush.Server -- --serverUrl http://127.0.0.1:12346 --serverKey <esk_key> --serverId score-rush-srv-1 --region eu --capacity 24

# terminal 2: client A
dotnet run --project csharp-sdk/EthernalCosmos.ScoreRush.Client

# terminal 3: client B
dotnet run --project csharp-sdk/EthernalCosmos.ScoreRush.Client
```

## Manual test scenarios

- Normal round completion with both players moving and collecting points
- One player leaves mid-round -> immediate forfeit resolution
- Simulated client disconnect and login again to resume
- Locked lobby join request flow (request/accept/reject)
- Host transfer and kick/unkick behavior
- Leaderboard refresh after rounds

## Notes

- Client sends movement intent (`input`) only; server holds game truth.
- Rebound flow currently restarts round state after takeover (no external state persistence yet).
- If no game server is available, creating a lobby for this game fails by design (`required`).
