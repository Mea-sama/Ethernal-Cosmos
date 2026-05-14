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
/// var lobby = await client.CreateLobbyAsync("chess", "Fast game");
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
    public event Action<UserDataPayload>?       UserData;
    public event Action<PlayerDataPayload>?     PlayerData;

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
    }

    // ─── Lobby ────────────────────────────────────────────────────────────────

    /// <summary>Create a new lobby and wait for server confirmation.</summary>
    public Task<Lobby> CreateLobbyAsync(
        string gameId, string name,
        bool isPrivate = false,
        Dictionary<string, object?>? settings = null,
        CancellationToken ct = default)
    {
        var data = new
        {
            gameId,
            name,
            isPrivate,
            settings = settings ?? []
        };
        return SocketRequestAsync<Lobby>("createLobby", data, "lobbyCreated", ct);
    }

    /// <summary>Join an existing lobby by ID.</summary>
    public Task<Lobby> JoinLobbyAsync(string lobbyId, CancellationToken ct = default) =>
        SocketRequestAsync<Lobby>("joinLobby", new { lobbyId }, "lobbyUpdated", ct);

    /// <summary>Join a private lobby using a 6-character invite code.</summary>
    public Task<Lobby> JoinLobbyByCodeAsync(string code, CancellationToken ct = default) =>
        SocketRequestAsync<Lobby>("joinLobbyByCode", new { code }, "lobbyUpdated", ct);

    /// <summary>Leave the current lobby.</summary>
    public Task LeaveLobbyAsync() =>
        GetSocket().EmitAsync("leaveLobby");

    /// <summary>Fetch all open lobbies for a given game.</summary>
    public Task<Lobby[]> ListLobbiesAsync(string gameId, CancellationToken ct = default) =>
        SocketRequestAsync<Lobby[]>("listLobbies", gameId, "lobbyList", ct);

    /// <summary>Get a snapshot of the current lobby state.</summary>
    public Task<Lobby> GetLobbyInfoAsync(CancellationToken ct = default) =>
        SocketRequestAsync<Lobby>("getLobbyInfo", null, "lobbyInfo", ct);

    /// <summary>(Host only) Kick a player from the lobby.</summary>
    public Task KickPlayerAsync(string playerId) =>
        GetSocket().EmitAsync("kickPlayer", new { playerId });

    /// <summary>(Host only) Transfer the host role to another player.</summary>
    public Task TransferHostAsync(string playerId) =>
        GetSocket().EmitAsync("transferHost", new { playerId });

    // ─── Relay ────────────────────────────────────────────────────────────────

    /// <summary>Broadcast a typed message to all other players in the lobby.</summary>
    public Task SendToLobbyAsync(string type, object? payload = null) =>
        GetSocket().EmitAsync("sendToLobby", new { type, payload });

    /// <summary>Send a typed message directly to one player in the lobby.</summary>
    public Task SendToPlayerAsync(string playerId, string type, object? payload = null) =>
        GetSocket().EmitAsync("sendToPlayer", new { playerId, type, payload });

    // ─── Game Actions ─────────────────────────────────────────────────────────

    /// <summary>Forward a game action to the running game subprocess.</summary>
    public Task SendGameActionAsync(string type, object? payload = null) =>
        GetSocket().EmitAsync("gameAction", new { type, payload });

    // ─── User Data (Socket) ───────────────────────────────────────────────────

    /// <summary>Fetch the current user's own KV-data for a game (socket).</summary>
    public async Task<UserDataEntry[]> GetUserDataAsync(string gameId, CancellationToken ct = default)
    {
        var result = await SocketRequestAsync<UserDataPayload>("getUserData", gameId, "userData", ct);
        return result.Entries;
    }

    /// <summary>
    /// Fetch visible KV-data for another player (socket).
    /// Returns public data, plus lobby-scoped data if both players are in the same lobby.
    /// </summary>
    public async Task<UserDataEntry[]> GetPlayerDataAsync(string playerId, string gameId, CancellationToken ct = default)
    {
        var result = await SocketRequestAsync<PlayerDataPayload>(
            "getPlayerData", new { playerId, gameId }, "playerData", ct);
        return result.Entries;
    }

    // ─── Presence ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Request the current list of all online users.
    /// Resolves once the server responds. Also fires the <see cref="PresenceList"/> event.
    /// </summary>
    public Task<PresenceUser[]> ListPresenceAsync(CancellationToken ct = default) =>
        SocketRequestAsync<PresenceUser[]>("presence:list", null, "presence:list", ct);

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

        socket.OnConnected += (_, _) => Connected?.Invoke();
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
        RegisterEvent<UserDataPayload>(socket,  "userData",      d => UserData?.Invoke(d));
        RegisterEvent<PlayerDataPayload>(socket,"playerData",    d => PlayerData?.Invoke(d));

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

    private SocketIOClient.SocketIO GetSocket()
    {
        if (_socket is null || !_socket.Connected)
            throw new InvalidOperationException(
                "Kein aktiver Socket — bitte zuerst LoginAsync() oder RegisterAsync() aufrufen.");
        return _socket;
    }

    private Task<T> SocketRequestAsync<T>(
        string emitEvent, object? data, string successEvent, CancellationToken ct)
    {
        var rawTcs = new TaskCompletionSource<SocketIOResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        var tcs    = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var socket = GetSocket();

        // Enqueue the raw TCS so our persistent event handler will resolve it
        lock (_pendingLock)
        {
            if (!_pending.TryGetValue(successEvent, out var q))
                _pending[successEvent] = q = new Queue<TaskCompletionSource<SocketIOResponse>>();
            q.Enqueue(rawTcs);
        }

        // Also enqueue for "error" event (server-side errors)
        var errTcs = new TaskCompletionSource<SocketIOResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_pendingLock)
        {
            if (!_pending.TryGetValue("error", out var qe))
                _pending["error"] = qe = new Queue<TaskCompletionSource<SocketIOResponse>>();
            qe.Enqueue(errTcs);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        cts.Token.Register(() =>
        {
            rawTcs.TrySetCanceled();
            errTcs.TrySetCanceled();
        });

        // Wire up the two raw TCS results into the typed TCS
        rawTcs.Task.ContinueWith(t =>
        {
            if (t.IsCanceled) { tcs.TrySetCanceled(); return; }
            if (t.IsFaulted)  { tcs.TrySetException(t.Exception!); return; }
            // Cancel the error waiter — we got the success response
            errTcs.TrySetCanceled();
            try   { tcs.TrySetResult(t.Result.GetValue<T>(0)); }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }, TaskScheduler.Default);

        errTcs.Task.ContinueWith(t =>
        {
            if (t.IsCanceled || t.IsFaulted) return; // already handled
            rawTcs.TrySetCanceled();
            try   { tcs.TrySetException(new Exception(t.Result.GetValue<string>(0))); }
            catch { tcs.TrySetException(new Exception("Server error")); }
        }, TaskScheduler.Default);

        // Also register for "error" event in socket in case it was never registered
        socket.On("error", response =>
        {
            lock (_pendingLock)
            {
                if (_pending.TryGetValue("error", out var q) && q.Count > 0)
                    q.Dequeue().TrySetResult(response);
            }
        });

        var emitTask = data is null
            ? socket.EmitAsync(emitEvent)
            : socket.EmitAsync(emitEvent, data);

        emitTask.ContinueWith(t =>
        {
            if (t.IsFaulted) tcs.TrySetException(t.Exception!);
        }, TaskContinuationOptions.OnlyOnFaulted);

        return tcs.Task;
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
