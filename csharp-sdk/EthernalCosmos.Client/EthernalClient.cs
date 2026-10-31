using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using EthernalCosmos.Client.Models;
using SocketIOClient;

namespace EthernalCosmos.Client;

/// <summary>
/// Options for configuring the <see cref="EthernalClient"/>.
/// </summary>
public sealed class EthernalClientOptions
{
    /// <summary>Base URL of the Ethernal Cosmos hub server, e.g. "http://localhost:12346".</summary>
    public required string ServerUrl { get; init; }

    /// <summary>Timeout for socket request/response patterns. Default: 5 seconds.</summary>
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(5);
}

/// <summary>
/// C# client for the Ethernal Cosmos platform.
/// </summary>
/// <example>
/// <code>
/// var client = new EthernalClient(new EthernalClientOptions { ServerUrl = "http://localhost:12346" });
/// await client.LoginAsync("alice", "secret");
/// client.LobbyUpdated += lobby => Console.WriteLine(lobby.Name);
/// await client.RegisterGameAsync("chess");
/// var lobby = await client.CreateLobbyAsync("Fast game");
/// </code>
/// </example>
public sealed class EthernalClient : IAsyncDisposable
{
    // ─── Events ───────────────────────────────────────────────────────────────

    public event Action?                        Connected;
    public event Action<string>?                Disconnected;
    /// <summary>Fired when authentication fails (e.g. token expired and refresh failed).</summary>
    public event Action<string>?                AuthError;
    /// <summary>Fired for server-side error messages.</summary>
    public event Action<string>?                ServerError;

    public event Action<HelloPayload>?          Hello;
    /// <summary>Raised when a lobby membership was resumed after a reconnect or on a second device.</summary>
    public event Action<SessionResumedData>?    SessionResumed;
    /// <summary>Raised when a newer game session of the same user replaced this one.</summary>
    public event Action<SessionReplacedData>?   SessionReplaced;
    public event Action<HubErrorPayload>?       ErrorDetail;
    public event Action<Lobby>?                 LobbyCreated;
    public event Action<Lobby>?                 LobbyUpdated;
    public event Action<Lobby[]>?               LobbyList;
    public event Action<Lobby>?                 LobbyInfo;
    public event Action<GameStartingData>?      GameStarting;
    public event Action<JsonElement>?           GameState;
    public event Action<JsonElement>?           GameEvent;
    public event Action<JsonElement>?           GameOver;
    public event Action<PlayerKickedData>?      PlayerKicked;
    public event Action<RelayMessage>?          Message;
    public event Action<RelayBinaryMessage>?    MessageBinary;
    public event Action<UserDataPayload>?       UserData;
    public event Action<PlayerDataPayload>?     PlayerData;

    /// <summary>Host: a new join request has arrived for a locked lobby.</summary>
    public event Action<JoinRequestReceivedData>?  JoinRequestReceived;
    /// <summary>Requester: confirmation that a join request was sent and is awaiting the host.</summary>
    public event Action<JoinRequestPendingData>?   JoinRequestPending;
    /// <summary>Requester: the host accepted — you have already been added to the lobby.</summary>
    public event Action<JoinRequestAcceptedData>?  JoinRequestAccepted;
    /// <summary>Requester: the request ended without joining (declined, timed out, host changed, or lobby closed).</summary>
    public event Action<JoinRequestRejectedData>?  JoinRequestRejected;
    /// <summary>Host: a pending request was withdrawn (requester cancelled or it timed out).</summary>
    public event Action<JoinRequestWithdrawnData>? JoinRequestWithdrawn;

    // Presence
    /// <summary>A user connected or their presence info changed (lobby joined/left, game started).</summary>
    public event Action<PresenceUser>?          PresenceJoined;
    /// <summary>A user disconnected. Argument is the userId.</summary>
    public event Action<string>?                PresenceLeft;
    /// <summary>Response to <see cref="ListPresenceAsync"/>: full list of online users.</summary>
    public event Action<PresenceUser[]>?        PresenceList;

    // ─── Fields ───────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string        _serverUrl;
    private readonly TimeSpan      _timeout;
    private readonly HttpClient    _http;

    private SocketIOClient.SocketIO? _socket;
    private string? _accessToken;
    private string? _refreshToken;
    private string? _registeredGameId;
    private (string? ClientVersion, string? Platform) _registerOptions;

    // Pending one-shot request/response queues (keyed by success-event name)
    private readonly Dictionary<string, Queue<TaskCompletionSource<SocketIOResponse>>> _pending = [];
    private readonly object _pendingLock = new();

    // ─── Constructor ──────────────────────────────────────────────────────────

    public EthernalClient(EthernalClientOptions options)
    {
        _serverUrl = options.ServerUrl.TrimEnd('/');
        _timeout   = options.RequestTimeout;
        _http      = new HttpClient { BaseAddress = new Uri(_serverUrl + "/") };
    }

    // ─── Auth ─────────────────────────────────────────────────────────────────

    /// <summary>Register a new account and connect the socket.</summary>
    public async Task<AuthResult> RegisterAsync(string username, string password, CancellationToken ct = default)
    {
        var result = await PostAsync<AuthResult>("/auth/register", new { username, password }, ct);
        StoreTokens(result.AccessToken, result.RefreshToken);
        await ConnectSocketAsync(ct);
        return result;
    }

    /// <summary>Log in and connect the socket.</summary>
    public async Task<AuthResult> LoginAsync(string username, string password, CancellationToken ct = default)
    {
        var result = await PostAsync<AuthResult>("/auth/login", new { username, password }, ct);
        StoreTokens(result.AccessToken, result.RefreshToken);
        await ConnectSocketAsync(ct);
        return result;
    }

    /// <summary>Log out: revoke the refresh token and disconnect the socket.</summary>
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        if (_refreshToken is not null)
        {
            try { await PostAsync<object?>("/auth/logout", new { refreshToken = _refreshToken }, ct); }
            catch { /* best-effort */ }
        }
        if (_socket is not null)
        {
            await _socket.DisconnectAsync();
            _socket = null;
        }
        _accessToken  = null;
        _refreshToken = null;
        _registeredGameId = null;
    }

    // ─── Session ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Register the game this client plays. Required once per connection (after login) before
    /// lobbies, relay or game actions can be used. It is re-sent automatically after a reconnect.
    /// </summary>
    public async Task<RegisterGameResult> RegisterGameAsync(
        string gameId, string? clientVersion = null, string? platform = null, CancellationToken ct = default)
    {
        var res = await CallAsync<RegisterGameResult>("session:registerGame", new { gameId, clientVersion, platform }, ct);
        _registeredGameId = gameId;
        _registerOptions = (clientVersion, platform);
        return res;
    }

    /// <summary>Pull the current session state (game + lobby), e.g. after a reconnect.</summary>
    public Task<SessionStateResult> GetSessionStateAsync(CancellationToken ct = default) =>
        CallAsync<SessionStateResult>("session:getState", null, ct);

    // ─── Lobby ────────────────────────────────────────────────────────────────

    /// <summary>Create a new lobby for the registered game.</summary>
    public async Task<Lobby> CreateLobbyAsync(
        string name,
        bool isPrivate = false,
        Dictionary<string, object?>? settings = null,
        CancellationToken ct = default) =>
        (await CallAsync<LobbyResult>("createLobby", new { name, isPrivate, settings = settings ?? [] }, ct)).Lobby;

    /// <summary>Join a public lobby of the registered game by ID.</summary>
    public async Task<Lobby> JoinLobbyAsync(string lobbyId, CancellationToken ct = default) =>
        (await CallAsync<LobbyResult>("joinLobby", new { lobbyId }, ct)).Lobby;

    /// <summary>Join a lobby using a 6-character invite code.</summary>
    public async Task<Lobby> JoinLobbyByCodeAsync(string code, CancellationToken ct = default) =>
        (await CallAsync<LobbyResult>("joinLobbyByCode", new { code }, ct)).Lobby;

    /// <summary>Leave the current lobby.</summary>
    public Task LeaveLobbyAsync(CancellationToken ct = default) => CallAsync<object?>("leaveLobby", null, ct);

    /// <summary>Fetch open public lobbies of the registered game.</summary>
    public async Task<Lobby[]> ListLobbiesAsync(CancellationToken ct = default) =>
        (await CallAsync<LobbiesResult>("listLobbies", null, ct)).Lobbies;

    /// <summary>Get a snapshot of the current lobby state.</summary>
    public async Task<Lobby> GetLobbyInfoAsync(CancellationToken ct = default) =>
        (await CallAsync<LobbyResult>("getLobbyInfo", null, ct)).Lobby;

    /// <summary>(Host only) Kick a player from the lobby.</summary>
    public Task KickPlayerAsync(string playerId, CancellationToken ct = default) =>
        CallAsync<object?>("kickPlayer", new { playerId }, ct);

    /// <summary>(Host only) Transfer the host role to another player.</summary>
    public Task TransferHostAsync(string playerId, CancellationToken ct = default) =>
        CallAsync<object?>("transferHost", new { playerId }, ct);

    /// <summary>(Host only) Lock the lobby — further joins (including via invite code) require an accepted join request.</summary>
    public Task LockLobbyAsync(CancellationToken ct = default) => CallAsync<object?>("lockLobby", null, ct);

    /// <summary>(Host only) Unlock the lobby.</summary>
    public Task UnlockLobbyAsync(CancellationToken ct = default) => CallAsync<object?>("unlockLobby", null, ct);

    /// <summary>
    /// Request to join a locked lobby by ID. Resolves once the host accepts (already joined
    /// server-side) or throws when declined, timed out (~15s), or the host/lobby changes meanwhile.
    /// </summary>
    public Task<Lobby> RequestJoinLobbyAsync(string lobbyId) =>
        JoinRequestAsync("requestJoinLobby", new { lobbyId });

    /// <summary>Request to join a locked lobby using its invite code. See <see cref="RequestJoinLobbyAsync"/>.</summary>
    public Task<Lobby> RequestJoinLobbyByCodeAsync(string code) =>
        JoinRequestAsync("requestJoinLobbyByCode", new { code });

    /// <summary>Withdraw your own pending join request before the host has responded.</summary>
    public Task CancelJoinRequestAsync(string lobbyId, CancellationToken ct = default) =>
        CallAsync<object?>("cancelJoinRequest", new { lobbyId }, ct);

    /// <summary>(Host only) Accept or reject a pending join request (see <see cref="JoinRequestReceived"/>).</summary>
    public Task RespondJoinRequestAsync(string requesterId, bool accept, CancellationToken ct = default) =>
        CallAsync<object?>("respondJoinRequest", new { requesterId, accept }, ct);

    // ─── Relay ────────────────────────────────────────────────────────────────

    /// <summary>Broadcast a typed message to all other players in the lobby.</summary>
    public Task SendToLobbyAsync(string type, object? payload = null, CancellationToken ct = default) =>
        CallAsync<object?>("sendToLobby", new { type, payload }, ct);

    /// <summary>Send a typed message directly to one player in the lobby.</summary>
    public Task SendToPlayerAsync(string playerId, string type, object? payload = null, CancellationToken ct = default) =>
        CallAsync<object?>("sendToPlayer", new { playerId, type, payload }, ct);

    /// <summary>Broadcast a binary message to all other players in the lobby.</summary>
    public Task SendToLobbyBinaryAsync(int typeCode, byte[] payload, CancellationToken ct = default)
    {
        if (payload is null) throw new ArgumentNullException(nameof(payload));
        return CallAsync<object?>("sendToLobbyBinary", new { typeCode, payload }, ct);
    }

    /// <summary>Send a binary message directly to one player in the lobby.</summary>
    public Task SendToPlayerBinaryAsync(string playerId, int typeCode, byte[] payload, CancellationToken ct = default)
    {
        if (payload is null) throw new ArgumentNullException(nameof(payload));
        return CallAsync<object?>("sendToPlayerBinary", new { playerId, typeCode, payload }, ct);
    }

    // ─── Game Actions ─────────────────────────────────────────────────────────

    /// <summary>Forward a game action to the running game subprocess.</summary>
    public Task SendGameActionAsync(string type, object? payload = null, CancellationToken ct = default) =>
        CallAsync<object?>("gameAction", new { type, payload }, ct);

    // ─── User Data (Socket) ───────────────────────────────────────────────────

    /// <summary>Fetch the current user's own KV-data for a game (socket).</summary>
    public async Task<UserDataEntry[]> GetUserDataAsync(string gameId, CancellationToken ct = default) =>
        (await CallAsync<UserDataPayload>("getUserData", gameId, ct)).Entries;

    /// <summary>Fetch visible KV-data for another player (public, or lobby-scoped if you share a lobby).</summary>
    public async Task<UserDataEntry[]> GetPlayerDataAsync(string playerId, string gameId, CancellationToken ct = default) =>
        (await CallAsync<PlayerDataPayload>("getPlayerData", new { playerId, gameId }, ct)).Entries;

    /// <summary>Write one own key via socket. Server-scoped keys are read-only for clients (DATA_READ_ONLY).</summary>
    public Task SetUserDataAsync(string gameId, string key, object? value, DataVisibility? visibility = null, CancellationToken ct = default) =>
        CallAsync<object?>("setUserData", new { gameId, key, value, visibility = visibility?.ToString().ToLowerInvariant() }, ct);

    /// <summary>Atomically write several own keys via socket.</summary>
    public Task BulkSetUserDataAsync(
        string gameId,
        IEnumerable<(string Key, object? Value, DataVisibility? Visibility)> entries,
        CancellationToken ct = default)
    {
        var data = entries.Select(e => new { key = e.Key, value = e.Value, visibility = e.Visibility?.ToString().ToLowerInvariant() });
        return CallAsync<object?>("bulkSetUserData", new { gameId, entries = data }, ct);
    }

    /// <summary>Delete one own key via socket.</summary>
    public Task DeleteUserDataAsync(string gameId, string key, CancellationToken ct = default) =>
        CallAsync<object?>("deleteUserData", new { gameId, key }, ct);

    // ─── Presence ─────────────────────────────────────────────────────────────

    /// <summary>Request the current list of online users.</summary>
    public async Task<PresenceUser[]> ListPresenceAsync(CancellationToken ct = default) =>
        (await CallAsync<PresenceResult>("presence:list", null, ct)).Users;

    // ─── User Data (REST) ─────────────────────────────────────────────────────

    /// <summary>Set or update a single KV entry for the current user.</summary>
    public Task SetKeyAsync(string gameId, string key, object? value, DataVisibility? visibility = null, CancellationToken ct = default)
    {
        var body = visibility.HasValue
            ? (object)new { value, visibility = visibility.Value.ToString().ToLowerInvariant() }
            : new { value };
        return AuthedFetchAsync(
            HttpMethod.Put,
            $"/userdata/{Uri.EscapeDataString(gameId)}/{Uri.EscapeDataString(key)}",
            body, ct);
    }

    /// <summary>Delete a KV entry.</summary>
    public Task DeleteKeyAsync(string gameId, string key, CancellationToken ct = default) =>
        AuthedFetchAsync(HttpMethod.Delete,
            $"/userdata/{Uri.EscapeDataString(gameId)}/{Uri.EscapeDataString(key)}",
            null, ct);

    /// <summary>Set or update multiple KV entries in one call (max 100).</summary>
    public Task BulkSetAsync(
        string gameId,
        IEnumerable<(string Key, object? Value, DataVisibility? Visibility)> entries,
        CancellationToken ct = default)
    {
        var data = entries.Select(e => new
        {
            key   = e.Key,
            value = e.Value,
            visibility = e.Visibility.HasValue
                ? e.Visibility.Value.ToString().ToLowerInvariant()
                : null
        });
        return AuthedFetchAsync(HttpMethod.Patch,
            $"/userdata/{Uri.EscapeDataString(gameId)}",
            new { data }, ct);
    }

    /// <summary>Fetch all own KV entries for a game via REST.</summary>
    public Task<UserDataEntry[]> GetAllDataAsync(string gameId, CancellationToken ct = default) =>
        AuthedFetchAsync<UserDataEntry[]>(HttpMethod.Get,
            $"/userdata/{Uri.EscapeDataString(gameId)}", null, ct);

    /// <summary>Fetch the public numeric leaderboard for a game key.</summary>
    public Task<LeaderboardEntry[]> GetLeaderboardAsync(
        string gameId, string key,
        string order = "desc", int limit = 10,
        CancellationToken ct = default)
    {
        var qs = $"?order={Uri.EscapeDataString(order)}&limit={limit}";
        return AuthedFetchAsync<LeaderboardEntry[]>(HttpMethod.Get,
            $"/leaderboard/{Uri.EscapeDataString(gameId)}/{Uri.EscapeDataString(key)}{qs}", null, ct);
    }

    // ─── Internal: Socket ─────────────────────────────────────────────────────

    private async Task ConnectSocketAsync(CancellationToken ct)
    {
        if (_socket is not null)
        {
            await _socket.DisconnectAsync();
            _socket = null;
        }

        var socket = new SocketIOClient.SocketIO(_serverUrl, new SocketIOOptions
        {
            Auth           = new Dictionary<string, string> { ["token"] = $"Bearer {_accessToken}" },
            ReconnectionAttempts = int.MaxValue,
            ReconnectionDelay    = 1000,
        });

        socket.OnConnected += async (_, _) =>
        {
            Connected?.Invoke();
            if (_registeredGameId is not null)
            {
                try { await RegisterGameAsync(_registeredGameId, _registerOptions.ClientVersion, _registerOptions.Platform); }
                catch (Exception ex) { ServerError?.Invoke(ex.Message); }
            }
        };
        socket.OnDisconnected += (_, reason) => Disconnected?.Invoke(reason);

        socket.OnError += (_, err) => ServerError?.Invoke(err);

        socket.OnReconnectError += async (_, err) =>
        {
            if (err.Message.Contains("INVALID_TOKEN") && _refreshToken is not null)
            {
                try
                {
                    await DoRefreshAsync(CancellationToken.None);
                    // Update auth and reconnect manually
                    socket.Options.Auth = new Dictionary<string, string>
                        { ["token"] = $"Bearer {_accessToken}" };
                }
                catch
                {
                    AuthError?.Invoke("Token konnte nicht erneuert werden");
                }
            }
        };

        RegisterEvent<HelloPayload>(socket,        "hello",            d => Hello?.Invoke(d));
        RegisterEvent<SessionResumedData>(socket,  "session:resumed",  d => SessionResumed?.Invoke(d));
        RegisterEvent<SessionReplacedData>(socket, "session:replaced", d => SessionReplaced?.Invoke(d));
        RegisterEvent<HubErrorPayload>(socket,     "errorDetail",      d => ErrorDetail?.Invoke(d));
        RegisterEvent<Lobby>(socket,     "lobbyCreated",  d => LobbyCreated?.Invoke(d));
        RegisterEvent<Lobby>(socket,     "lobbyUpdated",  d => LobbyUpdated?.Invoke(d));
        RegisterEvent<Lobby[]>(socket,   "lobbyList",     d => LobbyList?.Invoke(d));
        RegisterEvent<Lobby>(socket,     "lobbyInfo",     d => LobbyInfo?.Invoke(d));
        RegisterEvent<GameStartingData>(socket, "gameStarting", d => GameStarting?.Invoke(d));
        RegisterRaw(socket, "gameState",    d => GameState?.Invoke(d));
        RegisterRaw(socket, "gameEvent",    d => GameEvent?.Invoke(d));
        RegisterRaw(socket, "gameOver",     d => GameOver?.Invoke(d));
        RegisterEvent<PlayerKickedData>(socket, "playerKicked", d => PlayerKicked?.Invoke(d));
        RegisterEvent<RelayMessage>(socket,     "message",       d => Message?.Invoke(d));
        RegisterBinaryEvent(socket,             "messageBinary", d => MessageBinary?.Invoke(d));
        RegisterEvent<UserDataPayload>(socket,  "userData",      d => UserData?.Invoke(d));
        RegisterEvent<PlayerDataPayload>(socket,"playerData",    d => PlayerData?.Invoke(d));

        RegisterEvent<JoinRequestReceivedData>(socket,  "joinRequestReceived",  d => JoinRequestReceived?.Invoke(d));
        RegisterEvent<JoinRequestPendingData>(socket,   "joinRequestPending",   d => JoinRequestPending?.Invoke(d));
        RegisterEvent<JoinRequestAcceptedData>(socket,  "joinRequestAccepted",  d => JoinRequestAccepted?.Invoke(d));
        RegisterEvent<JoinRequestRejectedData>(socket,  "joinRequestRejected",  d => JoinRequestRejected?.Invoke(d));
        RegisterEvent<JoinRequestWithdrawnData>(socket, "joinRequestWithdrawn", d => JoinRequestWithdrawn?.Invoke(d));

        // Server-seitige Fehlermeldungen auch für fire-and-forget Events (z. B. Relay) sichtbar machen.
        socket.On("error", response =>
        {
            try { ServerError?.Invoke(response.GetValue<string>(0)); }
            catch { /* ignore malformed errors */ }
        });

        // Presence
        RegisterEvent<PresenceUser>(socket,   "presence:joined", d => PresenceJoined?.Invoke(d));
        RegisterEvent<PresenceUser[]>(socket, "presence:list",   d => PresenceList?.Invoke(d));
        // presence:left sends { userId: string }, extract the string
        socket.On("presence:left", response =>
        {
            lock (_pendingLock)
            {
                if (_pending.TryGetValue("presence:left", out var q) && q.Count > 0)
                { q.Dequeue().TrySetResult(response); return; }
            }
            try
            {
                var userId = response.GetValue<JsonElement>(0).GetProperty("userId").GetString() ?? "";
                PresenceLeft?.Invoke(userId);
            }
            catch { /* ignore */ }
        });

        _socket = socket;
        _pending.Clear();
        await socket.ConnectAsync();
    }

    private void RegisterEvent<T>(SocketIOClient.SocketIO socket, string eventName, Action<T> handler)
    {
        socket.On(eventName, response =>
        {
            // Fulfil a pending one-shot request first, if any
            lock (_pendingLock)
            {
                if (_pending.TryGetValue(eventName, out var q) && q.Count > 0)
                {
                    q.Dequeue().TrySetResult(response);
                    return;
                }
            }
            try
            {
                var value = response.GetValue<T>(0);
                handler(value);
            }
            catch { /* ignore deserialization errors */ }
        });
    }

    private void RegisterRaw(SocketIOClient.SocketIO socket, string eventName, Action<JsonElement> handler)
    {
        socket.On(eventName, response =>
        {
            lock (_pendingLock)
            {
                if (_pending.TryGetValue(eventName, out var q) && q.Count > 0)
                {
                    q.Dequeue().TrySetResult(response);
                    return;
                }
            }
            try { handler(response.GetValue<JsonElement>(0)); }
            catch { /* ignore */ }
        });
    }

    private void RegisterBinaryEvent(SocketIOClient.SocketIO socket, string eventName, Action<RelayBinaryMessage> handler)
    {
        socket.On(eventName, response =>
        {
            lock (_pendingLock)
            {
                if (_pending.TryGetValue(eventName, out var q) && q.Count > 0)
                {
                    q.Dequeue().TrySetResult(response);
                    return;
                }
            }

            try
            {
                // Preferred path: let the SocketIOClient serializer materialize the event payload.
                var typed = response.GetValue<RelayBinaryMessage>(0);
                if (typed is not null)
                {
                    handler(typed);
                    return;
                }

                // Compatibility path: parse manually from JsonElement.
                var root = response.GetValue<JsonElement>(0);
                var from = root.GetProperty("from").GetString() ?? "";
                var typeCode = root.GetProperty("typeCode").GetInt32();
                var payloadNode = root.GetProperty("payload");

                byte[] payload;
                if (payloadNode.ValueKind == JsonValueKind.String)
                {
                    payload = Convert.FromBase64String(payloadNode.GetString() ?? "");
                }
                else if (
                    payloadNode.ValueKind == JsonValueKind.Object
                    && payloadNode.TryGetProperty("data", out var dataArray)
                    && dataArray.ValueKind == JsonValueKind.Array)
                {
                    payload = dataArray.EnumerateArray().Select(v => (byte)v.GetInt32()).ToArray();
                }
                else
                {
                    payload = payloadNode.Deserialize<byte[]>() ?? [];
                }

                handler(new RelayBinaryMessage { From = from, TypeCode = typeCode, Payload = payload });
            }
            catch (Exception ex)
            {
                ServerError?.Invoke($"Binary event parse failed ({eventName}): {ex.Message}");
            }
        });
    }

    private SocketIOClient.SocketIO GetSocket()
    {
        if (_socket is null || !_socket.Connected)
            throw new InvalidOperationException(
                "Kein aktiver Socket — bitte zuerst LoginAsync() oder RegisterAsync() aufrufen.");
        return _socket;
    }

    private sealed class LobbyResult   { [JsonPropertyName("lobby")]   public Lobby   Lobby   { get; init; } = new(); }
    private sealed class LobbiesResult { [JsonPropertyName("lobbies")] public Lobby[] Lobbies { get; init; } = []; }
    private sealed class PresenceResult { [JsonPropertyName("users")]  public PresenceUser[] Users { get; init; } = []; }
    private sealed class JoinRequestAck
    {
        [JsonPropertyName("pending")] public bool   Pending { get; init; }
        [JsonPropertyName("lobby")]   public Lobby? Lobby   { get; init; }
    }

    /// <summary>Emits an event with an ack callback; throws <see cref="EthernalException"/> on a server error or timeout.</summary>
    private async Task<T> CallAsync<T>(string eventName, object? data, CancellationToken ct = default)
    {
        var raw = await EmitWithAckAsync(eventName, data, ct);
        return raw.Deserialize<T>(JsonOpts)!;
    }

    private async Task<JsonElement> EmitWithAckAsync(string eventName, object? data, CancellationToken ct)
    {
        var socket = GetSocket();
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        using var reg = cts.Token.Register(() =>
            tcs.TrySetException(new EthernalException("TIMEOUT", $"Timeout beim Warten auf \"{eventName}\"")));

        void OnAck(SocketIOResponse res)
        {
            try
            {
                var root = res.GetValue<JsonElement>(0);
                if (root.TryGetProperty("ok", out var ok) && ok.GetBoolean()) { tcs.TrySetResult(root); return; }
                var err = root.GetProperty("error").Deserialize<HubErrorPayload>(JsonOpts) ?? new HubErrorPayload();
                tcs.TrySetException(new EthernalException(err.Code, err.Message, err.RetryAfterMs));
            }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }

        if (data is null) await socket.EmitAsync(eventName, OnAck);
        else await socket.EmitAsync(eventName, OnAck, data);
        return await tcs.Task;
    }

    /// <summary>
    /// Sends a join request and resolves/rejects on the host's eventual answer
    /// ("joinRequestAccepted" / "joinRequestRejected"); the server allows ~15s for the host.
    /// </summary>
    private async Task<Lobby> JoinRequestAsync(string emitEvent, object data)
    {
        var acceptedTcs = new TaskCompletionSource<SocketIOResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        var rejectedTcs = new TaskCompletionSource<SocketIOResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pendingLock)
        {
            Enqueue("joinRequestAccepted", acceptedTcs);
            Enqueue("joinRequestRejected", rejectedTcs);
        }

        void Dequeue()
        {
            lock (_pendingLock)
            {
                foreach (var (key, waiter) in new[] { ("joinRequestAccepted", acceptedTcs), ("joinRequestRejected", rejectedTcs) })
                    if (_pending.TryGetValue(key, out var q))
                        _pending[key] = new Queue<TaskCompletionSource<SocketIOResponse>>(q.Where(w => w != waiter));
            }
        }

        try
        {
            var ack = (await EmitWithAckAsync(emitEvent, data, CancellationToken.None)).Deserialize<JoinRequestAck>(JsonOpts)!;
            if (ack.Lobby is not null) return ack.Lobby;

            var done = await Task.WhenAny(acceptedTcs.Task, rejectedTcs.Task, Task.Delay(16_000));
            if (done == acceptedTcs.Task) return acceptedTcs.Task.Result.GetValue<JoinRequestAcceptedData>(0).Lobby;
            if (done == rejectedTcs.Task)
                throw new EthernalException("LOBBY_LOCKED",
                    $"Beitrittsanfrage abgelehnt ({rejectedTcs.Task.Result.GetValue<JoinRequestRejectedData>(0).Reason})");
            throw new EthernalException("TIMEOUT", "Timeout beim Warten auf die Beitrittsanfrage");
        }
        finally { Dequeue(); }

        void Enqueue(string key, TaskCompletionSource<SocketIOResponse> waiter)
        {
            if (!_pending.TryGetValue(key, out var q)) _pending[key] = q = new Queue<TaskCompletionSource<SocketIOResponse>>();
            q.Enqueue(waiter);
        }
    }

    // ─── Internal: HTTP ───────────────────────────────────────────────────────

    private void StoreTokens(string accessToken, string refreshToken)
    {
        _accessToken  = accessToken;
        _refreshToken = refreshToken;
        _http.DefaultRequestHeaders.Remove("Authorization");
        _http.DefaultRequestHeaders.Add("Authorization", $"Bearer {accessToken}");
    }

    private async Task DoRefreshAsync(CancellationToken ct)
    {
        if (_refreshToken is null) throw new InvalidOperationException("Kein Refresh-Token vorhanden");
        var result = await PostAsync<AuthResult>("/auth/refresh", new { refreshToken = _refreshToken }, ct);
        StoreTokens(result.AccessToken, result.RefreshToken);
    }

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync(path.TrimStart('/'), body, JsonOpts, ct);
        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadFromJsonAsync<ErrorResponse>(JsonOpts, ct);
            throw new Exception(err?.Error ?? $"HTTP {(int)res.StatusCode}");
        }
        return (await res.Content.ReadFromJsonAsync<T>(JsonOpts, ct))!;
    }

    private async Task AuthedFetchAsync(HttpMethod method, string path, object? body, CancellationToken ct)
        => await AuthedFetchAsync<object?>(method, path, body, ct);

    private async Task<T> AuthedFetchAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var res = await SendAuthedAsync(method, path, body, ct);

        if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized && _refreshToken is not null)
        {
            res.Dispose();
            await DoRefreshAsync(ct);
            res = await SendAuthedAsync(method, path, body, ct);
        }

        using (res)
        {
            if (res.StatusCode == System.Net.HttpStatusCode.NoContent) return default!;
            if (!res.IsSuccessStatusCode)
            {
                var text = await res.Content.ReadAsStringAsync(ct);
                throw new Exception($"HTTP {(int)res.StatusCode}: {text}");
            }
            return (await res.Content.ReadFromJsonAsync<T>(JsonOpts, ct))!;
        }
    }

    private async Task<HttpResponseMessage> SendAuthedAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, path.TrimStart('/'));
        req.Headers.Add("Authorization", $"Bearer {_accessToken}");
        if (body is not null)
            req.Content = JsonContent.Create(body, options: JsonOpts);
        return await _http.SendAsync(req, ct);
    }

    // ─── IAsyncDisposable ─────────────────────────────────────────────────────

    public async ValueTask DisposeAsync()
    {
        if (_socket is not null)
        {
            await _socket.DisconnectAsync();
            _socket.Dispose();
        }
        _http.Dispose();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private sealed class ErrorResponse
    {
        [JsonPropertyName("error")] public string? Error { get; init; }
    }
}
