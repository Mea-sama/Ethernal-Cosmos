using System.Text.Json;
using System.Text.Json.Serialization;
using EthernalCosmos.Client.Models;
using SocketIOClient;

namespace EthernalCosmos.Client;

/// <summary>Options for <see cref="GameServerClient"/>.</summary>
public sealed class GameServerClientOptions
{
    /// <summary>Base URL of the hub, e.g. "http://localhost:12346" (the <c>/gameserver</c> namespace is appended).</summary>
    public required string ServerUrl { get; init; }

    /// <summary>Per-game server key (<c>esk_...</c>) issued with <c>POST /admin/game-servers/:gameId/keys</c>.</summary>
    public required string ServerKey { get; init; }

    /// <summary>Id of the game this server runs lobbies for; the game must have <c>serverSupport</c> other than <c>none</c>.</summary>
    public required string GameId { get; init; }

    /// <summary>Stable id of this server instance. Reconnecting with the same id within the hub's resume grace <b>resumes</b> the server and its lobbies.</summary>
    public required string ServerId { get; init; }

    /// <summary>Region used for the hub's candidate selection (requested region first).</summary>
    public string? Region { get; init; }

    /// <summary>Maximum number of simultaneous lobbies the hub may assign. Default: 10.</summary>
    public int Capacity { get; init; } = 10;

    /// <summary>Informational server version.</summary>
    public string? Version { get; init; }

    /// <summary>Timeout for request/response calls and the connect handshake. Default: 5 seconds.</summary>
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(5);
}

/// <summary>
/// C# client for the hub's <c>/gameserver</c> namespace: run the authoritative logic of many lobbies of one game in your own service.
/// See docs/game-server-protocol.md. Every call that fails throws <see cref="EthernalException"/> (e.g. <c>NOT_LOBBY_SERVER</c>, <c>NOT_ALLOWED</c>).
/// </summary>
/// <example>
/// <code>
/// await using var server = new GameServerClient(new GameServerClientOptions
/// {
///     ServerUrl = "http://localhost:12346", ServerKey = "esk_...", GameId = "chess", ServerId = "chess-eu-1", Capacity = 20,
/// });
/// server.PlayerAction += a => Console.WriteLine($"{a.UserId}: {a.Type}");
/// await server.ConnectAsync();
/// </code>
/// </example>
public sealed class GameServerClient : IAsyncDisposable
{
    // ─── Events ───────────────────────────────────────────────────────────────

    /// <summary>Raised when the socket connected (also after an automatic reconnect), before <see cref="Hello"/>.</summary>
    public event Action?                          Connected;
    /// <summary>Raised once per lost connection with the reason; the hub then holds your lobbies for its resume grace.</summary>
    public event Action<string>?                  Disconnected;
    /// <summary>Handshake answer after every (re)connect; <see cref="GameServerHello.Resumed"/> tells whether the hub kept your lobbies.</summary>
    public event Action<GameServerHello>?         Hello;
    /// <summary>A lobby was assigned and this server accepted it (after the answer was sent). See <see cref="AssignInfo.Reason"/> for new lobbies versus takeovers.</summary>
    public event Action<AssignInfo>?              LobbyAssigned;
    /// <summary>A lobby of this server changed (settings, players, status, server health).</summary>
    public event Action<GameServerLobbyUpdate>?   LobbyUpdated;
    /// <summary>A lobby of this server ended; it is no longer part of <see cref="Lobbies"/>.</summary>
    public event Action<GameServerLobbyClosed>?   LobbyClosed;
    /// <summary>A player joined a lobby of this server.</summary>
    public event Action<GameServerPlayerJoined>?  PlayerJoined;
    /// <summary>A player left a lobby of this server.</summary>
    public event Action<GameServerPlayerLeft>?    PlayerLeft;
    /// <summary>A player lost connection and is within the reconnect grace period.</summary>
    public event Action<GameServerPlayerPresence>? PlayerDisconnected;
    /// <summary>A disconnected player came back.</summary>
    public event Action<GameServerPlayerPresence>? PlayerReconnected;
    /// <summary>A player sent a game action (<c>SendGameActionAsync</c> on the player's client).</summary>
    public event Action<PlayerAction>?            PlayerAction;
    /// <summary>Raised for socket errors and exceptions thrown by event handlers' deserialization.</summary>
    public event Action<string>?                  ServerError;

    // ─── Fields ───────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly GameServerClientOptions _options;
    private readonly string _serverUrl;
    private readonly Dictionary<string, Lobby> _lobbies = [];
    private readonly object _lock = new();
    private SocketIOClient.SocketIO? _socket;
    private int _disconnectRaised;

    /// <summary>
    /// Decides on every <c>lobby:assigned</c>: return <see cref="AssignmentDecision.Accept"/> or <see cref="AssignmentDecision.Reject"/>.
    /// The hub waits for the answer only a few seconds (<c>SERVER_ASSIGN_TIMEOUT_MS</c>), so decide quickly. Default (null): accept every lobby.
    /// </summary>
    public Func<AssignInfo, Task<AssignmentDecision>>? AssignmentHandler { get; set; }

    /// <summary>Snapshot of the lobbies currently assigned to this server (latest known state, kept up to date by assignment, update, close and resume events).</summary>
    public IReadOnlyList<Lobby> Lobbies
    {
        get { lock (_lock) return _lobbies.Values.ToArray(); }
    }

    /// <summary>The id this server connects with (<see cref="GameServerClientOptions.ServerId"/>); it matches <c>Lobby.Server.ServerId</c>.</summary>
    public string ServerId => _options.ServerId;

    /// <summary>Whether the socket is currently connected.</summary>
    public bool IsConnected => _socket?.Connected == true;

    /// <summary>Creates a client. Nothing connects until <see cref="ConnectAsync"/>.</summary>
    public GameServerClient(GameServerClientOptions options)
    {
        _options = options;
        _serverUrl = options.ServerUrl.TrimEnd('/');
    }

    // ─── Connection ───────────────────────────────────────────────────────────

    /// <summary>
    /// Connect to the <c>/gameserver</c> namespace with the server key and wait for the hub's <see cref="Hello"/>.
    /// Calling it again after <see cref="DisconnectAsync"/> (or a lost connection) with the same <c>ServerId</c> within the hub's resume grace
    /// <b>resumes</b> the server: <see cref="GameServerHello.Resumed"/> is true and its lobbies stay assigned.
    /// A second connection with the same <c>ServerId</c> replaces the older one.
    /// Throws <see cref="EthernalException"/> with <c>INVALID_INPUT</c>, <c>UNKNOWN_GAME</c>, <c>GAME_SERVER_NOT_ALLOWED</c>, <c>INVALID_SERVER_KEY</c>
    /// or <c>RATE_LIMITED</c> (see <see cref="EthernalException.RetryAfterMs"/>) when the hub refuses the connection.
    /// </summary>
    public async Task<GameServerHello> ConnectAsync(CancellationToken ct = default)
    {
        await CloseSocketAsync();
        Interlocked.Exchange(ref _disconnectRaised, 0);

        var auth = new Dictionary<string, object>
        {
            ["serverKey"] = _options.ServerKey,
            ["gameId"] = _options.GameId,
            ["serverId"] = _options.ServerId,
            ["capacity"] = _options.Capacity,
        };
        if (_options.Region is not null) auth["region"] = _options.Region;
        if (_options.Version is not null) auth["version"] = _options.Version;

        var socket = new SocketIOClient.SocketIO(_serverUrl + "/gameserver", new SocketIOOptions
        {
            Auth = auth,
            ReconnectionAttempts = int.MaxValue,
            ReconnectionDelay = 1000,
            ConnectionTimeout = _options.RequestTimeout,
        });

        var firstHello = new TaskCompletionSource<GameServerHello>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? connectError = null;

        socket.OnConnected += (_, _) =>
        {
            Interlocked.Exchange(ref _disconnectRaised, 0);
            Connected?.Invoke();
        };
        socket.OnDisconnected += (_, reason) => RaiseDisconnected(reason);
        socket.OnError += (_, err) =>
        {
            connectError ??= err;
            ServerError?.Invoke(err);
        };

        Register<GameServerHello>(socket, "hello", d =>
        {
            lock (_lock)
            {
                _lobbies.Clear();
                foreach (var l in d.Lobbies) _lobbies[l.Id] = l;
            }
            firstHello.TrySetResult(d);
            Hello?.Invoke(d);
        });
        socket.On("lobby:assigned", async response =>
        {
            AssignInfo info;
            try { info = response.GetValue<AssignInfo>(0); }
            catch (Exception ex)
            {
                ServerError?.Invoke("lobby:assigned parse failed: " + ex.Message);
                await response.CallbackAsync(new { accept = false, reason = "invalid payload" });
                return;
            }

            var decision = AssignmentDecision.Accept;
            if (AssignmentHandler is { } handler)
            {
                try { decision = await handler(info); }
                catch (Exception ex)
                {
                    ServerError?.Invoke("AssignmentHandler failed: " + ex.Message);
                    decision = AssignmentDecision.Reject("handler error");
                }
            }

            if (decision.AcceptLobby)
            {
                lock (_lock) _lobbies[info.Lobby.Id] = info.Lobby;
                await response.CallbackAsync(new { accept = true });
                try { LobbyAssigned?.Invoke(info); } catch { /* a faulty subscriber must not break the SDK */ }
            }
            else
            {
                await response.CallbackAsync(decision.RejectReason is null ? new { accept = false } : (object)new { accept = false, reason = decision.RejectReason });
            }
        });
        Register<GameServerLobbyUpdate>(socket, "lobby:updated", d =>
        {
            lock (_lock)
            {
                if (_lobbies.ContainsKey(d.Lobby.Id)) _lobbies[d.Lobby.Id] = d.Lobby;
            }
            LobbyUpdated?.Invoke(d);
        });
        Register<GameServerLobbyClosed>(socket, "lobby:closed", d =>
        {
            lock (_lock) _lobbies.Remove(d.LobbyId);
            LobbyClosed?.Invoke(d);
        });
        Register<GameServerPlayerJoined>(socket, "player:joined", d => PlayerJoined?.Invoke(d));
        Register<GameServerPlayerLeft>(socket, "player:left", d => PlayerLeft?.Invoke(d));
        Register<GameServerPlayerPresence>(socket, "player:disconnected", d => PlayerDisconnected?.Invoke(d));
        Register<GameServerPlayerPresence>(socket, "player:reconnected", d => PlayerReconnected?.Invoke(d));
        Register<PlayerAction>(socket, "player:action", d => PlayerAction?.Invoke(d));

        _socket = socket;
        try
        {
            await socket.ConnectAsync();
            if (!socket.Connected && connectError is not null)
                throw new InvalidOperationException(connectError);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_options.RequestTimeout);
            using var reg = cts.Token.Register(() => firstHello.TrySetCanceled());
            return await firstHello.Task;
        }
        catch (Exception ex) when (ex is not EthernalException && !ct.IsCancellationRequested)
        {
            _socket = null;
            socket.Dispose();
            var raw = connectError ?? ex.Message;
            if (raw == ErrorCode.RateLimited.Wire())
                raw = await ConnectErrorProbe.RunAsync(_serverUrl, "/gameserver", auth, TimeSpan.FromSeconds(3)) ?? raw;
            throw EthernalException.FromConnectError(raw, ex);
        }
    }

    /// <summary>
    /// Close the socket without telling the hub anything else. The hub keeps your lobbies for its resume grace period; call <see cref="ConnectAsync"/>
    /// with the same <c>ServerId</c> to resume, otherwise the lobbies are rebound to another server (<see cref="LobbyAssignReason.ServerRebound"/>).
    /// Raises <see cref="Disconnected"/> exactly once.
    /// </summary>
    public Task DisconnectAsync() => CloseSocketAsync();

    // ─── Lobby control ────────────────────────────────────────────────────────

    /// <summary>
    /// Send a typed message to all lobby members (<paramref name="toUserId"/> = null) or to one member (appears as sender <c>server</c> in the client's <c>Message</c> event).
    /// Returns the per-lobby sequence number. Throws <c>PLAYER_NOT_IN_LOBBY</c> when <paramref name="toUserId"/> is not in the lobby.
    /// </summary>
    public async Task<long> RelayAsync(string lobbyId, string type, object? payload = null, string? toUserId = null, CancellationToken ct = default) =>
        (await CallAsync<SeqAck>("lobby:relay", new { lobbyId, toUserId, type, payload }, ct)).Seq;

    /// <summary>Broadcast a typed message to all members of the lobby (<see cref="RelayAsync"/> without target).</summary>
    public Task<long> RelayToLobbyAsync(string lobbyId, string type, object? payload = null, CancellationToken ct = default) =>
        RelayAsync(lobbyId, type, payload, null, ct);

    /// <summary>Send a typed message to a single member of the lobby (<see cref="RelayAsync"/> with target).</summary>
    public Task<long> RelayToPlayerAsync(string lobbyId, string userId, string type, object? payload = null, CancellationToken ct = default) =>
        RelayAsync(lobbyId, type, payload, userId, ct);

    /// <summary>Send the game state (<c>GameState</c> event) to all members, or to one member when <paramref name="toUserId"/> is set.</summary>
    public Task SendStateAsync(string lobbyId, object? state, string? toUserId = null, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:state", new { lobbyId, toUserId, state }, ct);

    /// <summary>Kick a player out of the lobby with an optional <paramref name="reason"/> (max. 200 chars). The kick is soft: they cannot rejoin until the host lifts it. They receive <c>PlayerKicked</c>.</summary>
    public Task KickPlayerAsync(string lobbyId, string userId, string? reason = null, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:kick", new { lobbyId, userId, reason }, ct);

    /// <summary>Set the lobby status to <see cref="LobbyStatus.InProgress"/> or <see cref="LobbyStatus.Closed"/> and return the updated lobby.</summary>
    public async Task<Lobby> SetLobbyStateAsync(string lobbyId, LobbyStatus state, CancellationToken ct = default)
    {
        if (state is not (LobbyStatus.InProgress or LobbyStatus.Closed))
            throw new ArgumentOutOfRangeException(nameof(state), "Only InProgress and Closed can be set by a game server.");
        return (await CallAsync<LobbyAck>("lobby:setState", new { lobbyId, state = state.Wire() }, ct)).Lobby;
    }

    /// <summary>Replace the lobby settings (members get a <c>settings_changed</c> update) and return the updated lobby.</summary>
    public async Task<Lobby> SetLobbySettingsAsync(string lobbyId, Dictionary<string, object?> settings, CancellationToken ct = default) =>
        (await CallAsync<LobbyAck>("lobby:setSettings", new { lobbyId, settings }, ct)).Lobby;

    /// <summary>Announce the result to all members (<c>GameOver</c> event) and close the lobby.</summary>
    public Task GameOverAsync(string lobbyId, object? result = null, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:gameOver", new { lobbyId, result }, ct);

    /// <summary>Close the lobby without a result.</summary>
    public Task CloseLobbyAsync(string lobbyId, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:close", new { lobbyId }, ct);

    // ─── Status ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Report the server status (also usable as a heartbeat): <paramref name="draining"/> and/or a new <paramref name="capacity"/>.
    /// Returns the hub's view of this server including its current <see cref="GameServerInfo.Load"/>.
    /// </summary>
    public async Task<GameServerInfo> ReportStatusAsync(bool? draining = null, int? capacity = null, CancellationToken ct = default) =>
        (await CallAsync<InfoAck>("server:status", new { draining, capacity }, ct)).Info;

    /// <summary>
    /// Start (default) or stop draining: a draining server receives no new lobbies while existing ones keep running
    /// (members see <c>ServerStatus</c> <c>Draining</c>, reason <c>ServerDraining</c>).
    /// </summary>
    public Task<GameServerInfo> DrainAsync(bool draining = true, CancellationToken ct = default) => ReportStatusAsync(draining, null, ct);

    // ─── Player data (server-authoritative) ───────────────────────────────────
    // userId must be a current or former member of a lobby bound to this server (up to 60 s after it closed), otherwise NOT_ALLOWED.

    /// <summary>
    /// Write one key of a player. <see cref="DataVisibility.Public"/> marks a leaderboard key (implies write scope server; only games with server support).
    /// Without <paramref name="visibility"/> the existing one is kept (new keys: private). Throws <c>NOT_ALLOWED</c> when <paramref name="userId"/> never was a member of <paramref name="lobbyId"/>.
    /// </summary>
    public Task SetDataAsync(string lobbyId, string userId, string key, object? value, DataVisibility? visibility = null, DataWriteScope? writeScope = null, CancellationToken ct = default) =>
        CallAsync<object?>("data:set", new { lobbyId, userId, key, value, visibility = visibility?.Wire(), writeScope = writeScope?.Wire() }, ct);

    /// <summary>Write 1–100 keys of a player all-or-nothing.</summary>
    public Task BulkSetDataAsync(string lobbyId, string userId, IEnumerable<GameServerDataEntry> entries, CancellationToken ct = default)
    {
        var data = entries.Select(e => new { key = e.Key, value = e.Value, visibility = e.Visibility?.Wire(), writeScope = e.WriteScope?.Wire() }).ToArray();
        return CallAsync<object?>("data:bulk", new { lobbyId, userId, entries = data }, ct);
    }

    /// <summary>Read all stored data of a player for this game.</summary>
    public async Task<UserDataEntry[]> GetDataAsync(string lobbyId, string userId, CancellationToken ct = default) =>
        (await CallAsync<EntriesAck>("data:get", new { lobbyId, userId }, ct)).Entries;

    /// <summary>Atomically add <paramref name="by"/> to a numeric key of a player (missing = 0) and return the new value and version.</summary>
    public Task<UserDataWriteResult> IncrementDataAsync(string lobbyId, string userId, string key, double by, DataVisibility? visibility = null, DataWriteScope? writeScope = null, CancellationToken ct = default) =>
        CallAsync<UserDataWriteResult>("data:increment", new { lobbyId, userId, key, by, visibility = visibility?.Wire(), writeScope = writeScope?.Wire() }, ct);

    /// <summary>Compare-and-set a key of a player; throws <c>VERSION_CONFLICT</c> (see <see cref="EthernalException.Conflict"/>) when the version differs (0 = key must not exist).</summary>
    public Task<UserDataWriteResult> SetDataIfAsync(string lobbyId, string userId, string key, object? value, int expectedVersion, DataVisibility? visibility = null, DataWriteScope? writeScope = null, CancellationToken ct = default) =>
        CallAsync<UserDataWriteResult>("data:setIf", new { lobbyId, userId, key, value, expectedVersion, visibility = visibility?.Wire(), writeScope = writeScope?.Wire() }, ct);

    /// <summary>Run 1–100 operations (<see cref="UserDataOp"/>) on a player's keys all-or-nothing and return one result per operation.</summary>
    public async Task<UserDataOpResult[]> TransactDataAsync(string lobbyId, string userId, IEnumerable<UserDataOp> ops, CancellationToken ct = default) =>
        (await CallAsync<TransactAck>("data:transact", new { lobbyId, userId, ops = ops.ToArray() }, ct)).Results;

    // ─── Internals ────────────────────────────────────────────────────────────

    private sealed class SeqAck { [JsonPropertyName("seq")] public long Seq { get; init; } }
    private sealed class LobbyAck { [JsonPropertyName("lobby")] public Lobby Lobby { get; init; } = new(); }
    private sealed class InfoAck { [JsonPropertyName("info")] public GameServerInfo Info { get; init; } = new(); }
    private sealed class EntriesAck { [JsonPropertyName("entries")] public UserDataEntry[] Entries { get; init; } = []; }
    private sealed class TransactAck { [JsonPropertyName("results")] public UserDataOpResult[] Results { get; init; } = []; }

    private void Register<T>(SocketIOClient.SocketIO socket, string eventName, Action<T> handler)
    {
        socket.On(eventName, response =>
        {
            try { handler(response.GetValue<T>(0)); }
            catch (Exception ex) { ServerError?.Invoke($"{eventName} failed: {ex.Message}"); }
        });
    }

    private void RaiseDisconnected(string reason)
    {
        if (Interlocked.Exchange(ref _disconnectRaised, 1) != 0) return;
        try { Disconnected?.Invoke(reason); }
        catch { /* a faulty subscriber must not break the SDK */ }
    }

    private async Task CloseSocketAsync()
    {
        var socket = _socket;
        if (socket is null) return;
        _socket = null;
        try { await socket.DisconnectAsync(); }
        catch { /* already closed */ }
        RaiseDisconnected("io client disconnect");
        socket.Dispose();
    }

    private async Task<T> CallAsync<T>(string eventName, object data, CancellationToken ct)
    {
        var socket = _socket;
        if (socket is null || !socket.Connected)
            throw new InvalidOperationException("Not connected - call ConnectAsync() first.");

        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_options.RequestTimeout);
        using var reg = cts.Token.Register(() =>
            tcs.TrySetException(new EthernalException("TIMEOUT", $"Timeout waiting for \"{eventName}\"")));

        void OnAck(SocketIOResponse res)
        {
            try
            {
                var root = res.GetValue<JsonElement>(0);
                if (root.TryGetProperty("ok", out var ok) && ok.GetBoolean()) { tcs.TrySetResult(root.Clone()); return; }
                var err = root.GetProperty("error").Deserialize<HubErrorPayload>(JsonOpts) ?? new HubErrorPayload();
                tcs.TrySetException(err.ToException());
            }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }

        // The hub validates strictly and rejects explicit nulls for optional fields, so null members are omitted
        await socket.EmitAsync(eventName, OnAck, JsonSerializer.SerializeToElement(data, JsonOpts));
        return (await tcs.Task).Deserialize<T>(JsonOpts)!;
    }

    // ─── IAsyncDisposable ─────────────────────────────────────────────────────

    /// <summary>Disconnects and releases all resources.</summary>
    public async ValueTask DisposeAsync() => await CloseSocketAsync();
}
