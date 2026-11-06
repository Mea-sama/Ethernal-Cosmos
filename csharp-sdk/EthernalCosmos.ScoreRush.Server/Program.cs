using System.Collections.Concurrent;
using System.Numerics;
using System.Text.Json;
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;
using EthernalCosmos.ScoreRush.Server;
using EthernalCosmos.ScoreRush.Shared;

var startup = ScoreRushServerStartup.ValidateArgs(args);
if (!startup.IsValid)
{
    Console.WriteLine(startup.Message);
    WaitForManualExit();
    return 2;
}

try
{
    await using var gs = new GameServerClient(startup.Options!);
    var app = new ScoreRushServerApp(gs);
    await app.RunAsync();
    return 0;
}
catch (Exception ex)
{
    Console.WriteLine($"Score Rush server failed to start: {ex.Message}");
    Console.WriteLine("This window will stay open so you can inspect the error and close it manually.");
    WaitForManualExit();
    return 1;
}

static void WaitForManualExit()
{
    if (!Environment.UserInteractive)
    {
        return;
    }

    Console.WriteLine("Press Enter to exit.");
    Console.ReadLine();
}

internal sealed class ScoreRushServerApp(GameServerClient client)
{
    private readonly GameServerClient _client = client;
    private readonly ConcurrentDictionary<string, LobbyRuntime> _lobbies = new(StringComparer.Ordinal);
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    public async Task RunAsync()
    {
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        WireHandlers();
        var hello = await _client.ConnectAsync(cts.Token);
        Console.WriteLine($"Game server connected: {hello.ServerId} game={hello.GameId} resumed={hello.Resumed} lobbies={hello.Lobbies.Length}");

        var tickTask = TickLoopAsync(cts.Token);
        var heartbeatTask = HeartbeatLoopAsync(cts.Token);

        try
        {
            await Task.Delay(Timeout.Infinite, cts.Token);
        }
        catch (OperationCanceledException)
        {
        }

        await _client.DrainAsync(true);
        await _client.DisconnectAsync();
        await Task.WhenAll(tickTask, heartbeatTask);
    }

    private void WireHandlers()
    {
        _client.Connected += () => Console.WriteLine("[GS] Connected");
        _client.Disconnected += reason => Console.WriteLine($"[GS] Disconnected: {reason}");
        _client.ServerError += error => Console.WriteLine($"[GS] Error: {error}");

        _client.AssignmentHandler = info =>
        {
            if (info.Players.Length > 2)
            {
                return Task.FromResult(AssignmentDecision.Reject("score-rush supports max 2 players"));
            }

            var runtime = _lobbies.AddOrUpdate(
                info.Lobby.Id,
                _ => LobbyRuntime.Create(info),
                (_, old) => old.ResetFromAssignment(info));

            if (info.Reason == LobbyAssignReason.ServerRebound)
            {
                runtime.SetStatus("Server rebound, round restarted");
                runtime.RebuildRound();
            }

            Console.WriteLine($"[GS] Assigned lobby={info.Lobby.Id} reason={info.Reason} players={info.Players.Length}");
            return Task.FromResult(AssignmentDecision.Accept);
        };

        _client.LobbyAssigned += info =>
        {
            var runtime = _lobbies.GetOrAdd(info.Lobby.Id, _ => LobbyRuntime.Create(info));
            runtime.SyncLobby(info.Lobby);
        };

        _client.LobbyUpdated += update =>
        {
            if (_lobbies.TryGetValue(update.Lobby.Id, out var runtime))
            {
                runtime.SyncLobby(update.Lobby);
                if (update.Reason is LobbyChangeReason.ServerLost or LobbyChangeReason.ServerResumed or LobbyChangeReason.ServerRebound)
                {
                    runtime.SetStatus($"Lobby change: {update.Reason}");
                }
            }
        };

        _client.LobbyClosed += closed =>
        {
            _lobbies.TryRemove(closed.LobbyId, out _);
            Console.WriteLine($"[GS] Lobby closed {closed.LobbyId} reason={closed.Reason}");
        };

        _client.PlayerJoined += joined =>
        {
            if (_lobbies.TryGetValue(joined.LobbyId, out var runtime))
            {
                runtime.PlayerJoined(joined.UserId, joined.Username);
                runtime.SetStatus($"{joined.Username} joined");
            }
        };

        _client.PlayerDisconnected += presence =>
        {
            if (_lobbies.TryGetValue(presence.LobbyId, out var runtime))
            {
                runtime.PlayerConnected(presence.UserId, false);
                runtime.SetStatus($"{presence.UserId} disconnected");
            }
        };

        _client.PlayerReconnected += presence =>
        {
            if (_lobbies.TryGetValue(presence.LobbyId, out var runtime))
            {
                runtime.PlayerConnected(presence.UserId, true);
                runtime.SetStatus($"{presence.UserId} reconnected");
            }
        };

        _client.PlayerLeft += left =>
        {
            if (_lobbies.TryGetValue(left.LobbyId, out var runtime))
            {
                runtime.PlayerLeft(left.UserId);
                if (runtime.TryPrepareRoundEnd("forfeit", out var result))
                {
                    _ = FinalizeRoundAsync(runtime, result, CancellationToken.None);
                }
            }
        };

        _client.PlayerAction += action =>
        {
            if (action.Type != ScoreRushGame.InputActionType) return;
            if (!_lobbies.TryGetValue(action.LobbyId, out var runtime)) return;

            try
            {
                var input = action.Payload.Deserialize<PlayerInputMessage>(_json);
                if (input is null) return;
                runtime.UpdateInput(action.UserId, input.X, input.Y);
            }
            catch (JsonException)
            {
                runtime.SetStatus("Invalid input payload ignored");
            }
        };
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await timer.WaitForNextTickAsync(ct);
                var info = await _client.ReportStatusAsync();
                Console.WriteLine($"[GS] Heartbeat load={info.Load}/{info.Capacity} draining={info.Draining}");
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[GS] Heartbeat failed: {ex.Message}");
            }
        }
    }

    private async Task TickLoopAsync(CancellationToken ct)
    {
        var last = DateTimeOffset.UtcNow;
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(50));

        while (!ct.IsCancellationRequested)
        {
            await timer.WaitForNextTickAsync(ct);
            var now = DateTimeOffset.UtcNow;
            var dt = (float)Math.Clamp((now - last).TotalSeconds, 0d, 0.25d);
            last = now;

            foreach (var runtime in _lobbies.Values)
            {
                await TickLobbyAsync(runtime, dt, now, ct);
            }
        }
    }

    private async Task TickLobbyAsync(LobbyRuntime runtime, float dt, DateTimeOffset now, CancellationToken ct)
    {
        ScoreRushSnapshot? snapshot = null;
        ScoreRushRoundResult? result = null;
        var shouldSetInProgress = false;

        lock (runtime.Sync)
        {
            if (!runtime.IsRoundActive && runtime.PlayerCount == 2)
            {
                runtime.StartRound(now);
                runtime.SetStatus("Round started");
                shouldSetInProgress = true;
            }

            runtime.TickSimulation(dt, now);

            if (!runtime.IsEnding && runtime.IsRoundActive && runtime.TimeLeftSeconds <= 0f)
            {
                runtime.TryPrepareRoundEnd("time", out result);
            }

            if (runtime.ShouldSendSnapshot(now))
            {
                snapshot = runtime.CreateSnapshot(now);
            }
        }

        if (shouldSetInProgress)
        {
            try
            {
                await _client.SetLobbyStateAsync(runtime.LobbyId, LobbyStatus.InProgress, ct);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[GS] setState failed lobby={runtime.LobbyId}: {ex.Message}");
            }
        }

        if (snapshot is not null)
        {
            try
            {
                await _client.SendStateAsync(runtime.LobbyId, snapshot, null, ct);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[GS] state send failed lobby={runtime.LobbyId}: {ex.Message}");
            }
        }

        if (result is not null)
        {
            await FinalizeRoundAsync(runtime, result, ct);
        }
    }

    private async Task FinalizeRoundAsync(LobbyRuntime runtime, ScoreRushRoundResult result, CancellationToken ct)
    {
        foreach (var player in result.Scores)
        {
            await UpdateBestScoreAsync(runtime.LobbyId, player, ct);
        }

        try
        {
            await _client.GameOverAsync(runtime.LobbyId, result, ct);
            runtime.SetStatus($"Round finished ({result.Reason})");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[GS] gameOver failed lobby={runtime.LobbyId}: {ex.Message}");
        }
    }

    private async Task UpdateBestScoreAsync(string lobbyId, ScoreRushPlayerView player, CancellationToken ct)
    {
        try
        {
            var entries = await _client.GetDataAsync(lobbyId, player.UserId, ct);
            var existing = entries.FirstOrDefault(e => string.Equals(e.Key, ScoreRushGame.LeaderboardKey, StringComparison.Ordinal));
            var current = existing is null ? int.MinValue : ReadInt(existing.Value);
            if (player.Score > current)
            {
                await _client.SetDataAsync(
                    lobbyId,
                    player.UserId,
                    ScoreRushGame.LeaderboardKey,
                    player.Score,
                    DataVisibility.Public,
                    DataWriteScope.Server,
                    ct);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[GS] best-score update failed user={player.UserId}: {ex.Message}");
        }
    }

    private static int ReadInt(object? value)
    {
        return value switch
        {
            int i => i,
            long l => (int)l,
            double d => (int)d,
            JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetInt32(out var i) => i,
            JsonElement je when je.ValueKind == JsonValueKind.Number => (int)je.GetDouble(),
            _ => 0,
        };
    }
}

internal sealed class LobbyRuntime
{
    private readonly Dictionary<string, PlayerState> _players = new(StringComparer.Ordinal);
    private readonly List<PickupState> _pickups = [];
    private readonly Random _random = Random.Shared;

    private int _nextPickupId = 1;
    private float _spawnBudget;
    private DateTimeOffset _roundEndsAt;
    private DateTimeOffset _lastSnapshotAt = DateTimeOffset.MinValue;

    public object Sync { get; } = new();
    public string LobbyId { get; }
    public bool IsRoundActive { get; private set; }
    public bool IsEnding { get; private set; }
    public int RoundSeconds { get; private set; } = ScoreRushGame.DefaultRoundSeconds;
    public string Status { get; private set; } = "Waiting for players";

    public int PlayerCount => _players.Count;

    public float TimeLeftSeconds =>
        IsRoundActive ? Math.Max(0f, (float)(_roundEndsAt - DateTimeOffset.UtcNow).TotalSeconds) : RoundSeconds;

    private LobbyRuntime(string lobbyId)
    {
        LobbyId = lobbyId;
    }

    public static LobbyRuntime Create(AssignInfo info)
    {
        var runtime = new LobbyRuntime(info.Lobby.Id);
        runtime.SyncLobby(info.Lobby);
        foreach (var player in info.Players)
        {
            runtime.PlayerJoined(player.UserId, player.Username);
        }

        return runtime;
    }

    public LobbyRuntime ResetFromAssignment(AssignInfo info)
    {
        lock (Sync)
        {
            _players.Clear();
            _pickups.Clear();
            _nextPickupId = 1;
            _spawnBudget = 0f;
            IsRoundActive = false;
            IsEnding = false;
            Status = "Assigned";
            SyncLobby(info.Lobby);
            foreach (var player in info.Players)
            {
                PlayerJoined(player.UserId, player.Username);
            }
        }

        return this;
    }

    public void RebuildRound()
    {
        lock (Sync)
        {
            _pickups.Clear();
            _nextPickupId = 1;
            _spawnBudget = 0f;
            IsRoundActive = false;
            IsEnding = false;
            foreach (var player in _players.Values)
            {
                player.Score = 0;
                player.Input = Vector2.Zero;
            }
        }
    }

    public void SyncLobby(Lobby lobby)
    {
        lock (Sync)
        {
            RoundSeconds = TryReadRoundSeconds(lobby.Settings);
            foreach (var lp in lobby.Players)
            {
                if (!_players.TryGetValue(lp.UserId, out var existing))
                {
                    var spawn = SpawnPoint(_players.Count);
                    _players[lp.UserId] = new PlayerState
                    {
                        UserId = lp.UserId,
                        Username = lp.Username,
                        X = spawn.X,
                        Y = spawn.Y,
                        Connected = lp.Connected,
                    };
                }
                else
                {
                    existing.Username = lp.Username;
                    existing.Connected = lp.Connected;
                }
            }

            var known = lobby.Players.Select(p => p.UserId).ToHashSet(StringComparer.Ordinal);
            foreach (var gone in _players.Keys.Where(id => !known.Contains(id)).ToList())
            {
                _players.Remove(gone);
            }
        }
    }

    public void PlayerJoined(string userId, string username)
    {
        lock (Sync)
        {
            if (_players.TryGetValue(userId, out var existing))
            {
                existing.Username = username;
                existing.Connected = true;
                return;
            }

            var spawn = SpawnPoint(_players.Count);
            _players[userId] = new PlayerState
            {
                UserId = userId,
                Username = username,
                X = spawn.X,
                Y = spawn.Y,
                Connected = true,
            };
        }
    }

    public void PlayerLeft(string userId)
    {
        lock (Sync)
        {
            _players.Remove(userId);
        }
    }

    public void PlayerConnected(string userId, bool connected)
    {
        lock (Sync)
        {
            if (_players.TryGetValue(userId, out var player))
            {
                player.Connected = connected;
            }
        }
    }

    public void UpdateInput(string userId, float x, float y)
    {
        lock (Sync)
        {
            if (!_players.TryGetValue(userId, out var player)) return;
            var input = new Vector2(x, y);
            if (input.LengthSquared() > 1f)
            {
                input = Vector2.Normalize(input);
            }

            player.Input = input;
        }
    }

    public void StartRound(DateTimeOffset now)
    {
        if (IsRoundActive) return;

        foreach (var p in _players.Values)
        {
            p.Score = 0;
            p.Input = Vector2.Zero;
        }

        _pickups.Clear();
        _nextPickupId = 1;
        _spawnBudget = 0f;

        for (var i = 0; i < ScoreRushGame.StartPickups; i++)
        {
            SpawnPickup();
        }

        IsRoundActive = true;
        IsEnding = false;
        _roundEndsAt = now.AddSeconds(RoundSeconds);
    }

    public void TickSimulation(float dt, DateTimeOffset now)
    {
        if (!IsRoundActive) return;

        foreach (var player in _players.Values)
        {
            var velocity = player.Input * ScoreRushGame.PlayerSpeed;
            player.X = Clamp(player.X + velocity.X * dt, ScoreRushGame.PlayerRadius, ScoreRushGame.ArenaWidth - ScoreRushGame.PlayerRadius);
            player.Y = Clamp(player.Y + velocity.Y * dt, ScoreRushGame.PlayerRadius, ScoreRushGame.ArenaHeight - ScoreRushGame.PlayerRadius);
        }

        for (var i = _pickups.Count - 1; i >= 0; i--)
        {
            var pickup = _pickups[i];
            var collector = _players.Values.FirstOrDefault(p => DistSq(p.X, p.Y, pickup.X, pickup.Y) <= MathF.Pow(ScoreRushGame.PlayerRadius + ScoreRushGame.PickupRadius, 2));
            if (collector is null) continue;
            collector.Score += pickup.Value;
            _pickups.RemoveAt(i);
        }

        _spawnBudget += dt * ScoreRushGame.SpawnPerSecond;
        while (_spawnBudget >= 1f && _pickups.Count < ScoreRushGame.MaxPickups)
        {
            _spawnBudget -= 1f;
            SpawnPickup();
        }

        if (now >= _roundEndsAt)
        {
            IsRoundActive = false;
        }
    }

    public bool ShouldSendSnapshot(DateTimeOffset now)
    {
        if ((now - _lastSnapshotAt).TotalMilliseconds < 100) return false;
        _lastSnapshotAt = now;
        return true;
    }

    public ScoreRushSnapshot CreateSnapshot(DateTimeOffset now) =>
        new()
        {
            Phase = IsRoundActive ? "in_progress" : "waiting",
            RoundSeconds = RoundSeconds,
            TimeLeftSec = IsRoundActive ? Math.Max(0f, (float)(_roundEndsAt - now).TotalSeconds) : RoundSeconds,
            ServerTimeMs = now.ToUnixTimeMilliseconds(),
            Players = _players.Values.Select(p => new ScoreRushPlayerView
            {
                UserId = p.UserId,
                Username = p.Username,
                X = p.X,
                Y = p.Y,
                Score = p.Score,
                Connected = p.Connected,
            }).ToArray(),
            Pickups = _pickups.Select(p => new ScoreRushPickupView { Id = p.Id, X = p.X, Y = p.Y, Value = p.Value }).ToArray(),
            Status = Status,
        };

    public bool TryPrepareRoundEnd(string reason, out ScoreRushRoundResult result)
    {
        result = null!;
        if (IsEnding) return false;
        if (_players.Count == 0) return false;

        IsEnding = true;
        IsRoundActive = false;

        var scoreboard = _players.Values
            .OrderByDescending(p => p.Score)
            .ThenBy(p => p.Username, StringComparer.OrdinalIgnoreCase)
            .Select(p => new ScoreRushPlayerView
            {
                UserId = p.UserId,
                Username = p.Username,
                Score = p.Score,
                X = p.X,
                Y = p.Y,
                Connected = p.Connected,
            })
            .ToArray();

        string? winnerId = null;
        string? winnerName = null;
        if (scoreboard.Length == 1)
        {
            winnerId = scoreboard[0].UserId;
            winnerName = scoreboard[0].Username;
        }
        else if (scoreboard.Length >= 2 && scoreboard[0].Score > scoreboard[1].Score)
        {
            winnerId = scoreboard[0].UserId;
            winnerName = scoreboard[0].Username;
        }

        result = new ScoreRushRoundResult
        {
            WinnerUserId = winnerId,
            WinnerUsername = winnerName,
            Reason = reason,
            Scores = scoreboard,
        };
        return true;
    }

    public void SetStatus(string status)
    {
        lock (Sync)
        {
            Status = status;
        }
    }

    private void SpawnPickup()
    {
        _pickups.Add(new PickupState
        {
            Id = _nextPickupId++,
            X = NextFloat(ScoreRushGame.PickupRadius, ScoreRushGame.ArenaWidth - ScoreRushGame.PickupRadius),
            Y = NextFloat(ScoreRushGame.PickupRadius, ScoreRushGame.ArenaHeight - ScoreRushGame.PickupRadius),
            Value = 1,
        });
    }

    private (float X, float Y) SpawnPoint(int index)
    {
        return index % 2 == 0
            ? (ScoreRushGame.ArenaWidth * 0.25f, ScoreRushGame.ArenaHeight * 0.5f)
            : (ScoreRushGame.ArenaWidth * 0.75f, ScoreRushGame.ArenaHeight * 0.5f);
    }

    private float NextFloat(float min, float max) => min + (float)_random.NextDouble() * (max - min);

    private static float Clamp(float value, float min, float max) => value < min ? min : (value > max ? max : value);

    private static float DistSq(float x1, float y1, float x2, float y2)
    {
        var dx = x1 - x2;
        var dy = y1 - y2;
        return dx * dx + dy * dy;
    }

    private static int TryReadRoundSeconds(IReadOnlyDictionary<string, object?> settings)
    {
        if (settings.TryGetValue("roundSeconds", out var value))
        {
            return value switch
            {
                int i when i > 10 => i,
                long l when l > 10 => (int)l,
                JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetInt32(out var i) && i > 10 => i,
                _ => ScoreRushGame.DefaultRoundSeconds,
            };
        }

        return ScoreRushGame.DefaultRoundSeconds;
    }

    private sealed class PlayerState
    {
        public string UserId { get; init; } = "";
        public string Username { get; set; } = "";
        public float X { get; set; }
        public float Y { get; set; }
        public int Score { get; set; }
        public bool Connected { get; set; } = true;
        public Vector2 Input { get; set; }
    }

    private sealed class PickupState
    {
        public int Id { get; init; }
        public float X { get; init; }
        public float Y { get; init; }
        public int Value { get; init; } = 1;
    }
}
