using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using EthernalCosmos.Client.Models;
using SocketIOClient;

namespace EthernalCosmos.Client;

/// <summary>Kind of socket session a client opens.</summary>
public enum ClientType
{
    /// <summary>The player's game session (default); a newer game session of the same user replaces it.</summary>
    Game,
    /// <summary>A companion session (overlay, chat panel, second device) that coexists with the game session.</summary>
    Panel,
}

/// <summary>
/// Options for configuring the <see cref="EthernalClient"/>.
/// </summary>
public sealed class EthernalClientOptions
{
    /// <summary>Base URL of the Ethernal Cosmos hub server, e.g. "http://localhost:12346".</summary>
    public required string ServerUrl { get; init; }

    /// <summary>Timeout for socket request/response patterns. Default: 5 seconds.</summary>
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// <see cref="ClientType.Game"/> (default) is the player's game session: a newer game session of the same user replaces it (<c>SessionReplaced</c>).
    /// Use <see cref="ClientType.Panel"/> for an additional companion session (overlay, chat panel, second device) that
    /// coexists with the game session, receives user-targeted events (DMs, read state, join-request confirmations) but does not take part in game presence.
    /// </summary>
    public ClientType ClientType { get; init; } = ClientType.Game;
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

    /// <summary>Raised when the socket connection is established (also after an automatic reconnect).</summary>
    public event Action?                        Connected;
    /// <summary>
    /// Raised once per lost connection; the argument is the reason. Also raised (with <c>"io client disconnect"</c>)
    /// after a local <see cref="DisconnectAsync"/>, <see cref="LogoutAsync"/> or dispose.
    /// </summary>
    public event Action<string>?                Disconnected;
    /// <summary>Fired when authentication fails (e.g. token expired and refresh failed).</summary>
    public event Action<string>?                AuthError;
    /// <summary>Fired for server-side error messages.</summary>
    public event Action<string>?                ServerError;

    /// <summary>Handshake data sent by the hub after every (re)connect.</summary>
    public event Action<HelloPayload>?          Hello;
    /// <summary>Raised when a lobby membership was resumed after a reconnect or on a second device.</summary>
    public event Action<SessionResumedData>?    SessionResumed;
    /// <summary>Raised when a newer game session of the same user replaced this one.</summary>
    public event Action<SessionReplacedData>?   SessionReplaced;
    /// <summary>Raised for every <c>error</c> event of the hub, with typed <see cref="HubErrorPayload.Error"/>.</summary>
    public event Action<HubErrorPayload>?       ErrorDetail;
    /// <summary>Raised after this client created a lobby.</summary>
    public event Action<Lobby>?                 LobbyCreated;
    /// <summary>Raised whenever a lobby you are in changed (see <see cref="LobbyChanged"/> for the reason).</summary>
    public event Action<Lobby>?                 LobbyUpdated;
    /// <summary>Lobby changed, with the reason (e.g. player_joined, server_lost, server_rebound).</summary>
    public event Action<Lobby, LobbyChangeReason?>? LobbyChanged;
    /// <summary>Raised with the result of a lobby listing.</summary>
    public event Action<Lobby[]>?               LobbyList;
    /// <summary>Raised with the result of a lobby lookup.</summary>
    public event Action<Lobby>?                 LobbyInfo;
    /// <summary>Raised when the hub starts the game process of a hosted lobby.</summary>
    public event Action<GameStartingData>?      GameStarting;
    /// <summary>Raised when the game broadcasts shared state (hosted games).</summary>
    public event Action<JsonElement>?           GameState;
    /// <summary>Raised when the game broadcasts an event (hosted games).</summary>
    public event Action<JsonElement>?           GameEvent;
    /// <summary>Raised when the game ended (hosted games).</summary>
    public event Action<JsonElement>?           GameOver;
    /// <summary>Raised when this client was kicked from a lobby.</summary>
    public event Action<PlayerKickedData>?      PlayerKicked;
    /// <summary>Raised for a relayed text/JSON message from another player.</summary>
    public event Action<RelayMessage>?          Message;
    /// <summary>Raised for a relayed binary message from another player.</summary>
    public event Action<RelayBinaryMessage>?    MessageBinary;
    /// <summary>Raised with own user data (also pushed by game servers).</summary>
    public event Action<UserDataPayload>?       UserData;
    /// <summary>Raised with visible data of another player.</summary>
    public event Action<PlayerDataPayload>?     PlayerData;

    /// <summary>Host: a new join request has arrived for a locked lobby.</summary>
    public event Action<JoinRequestReceivedData>?  JoinRequestReceived;
    /// <summary>Requester: confirmation that a join request was sent and is awaiting the host.</summary>
    public event Action<JoinRequestPendingData>?   JoinRequestPending;
    /// <summary>Requester: the host accepted — you have already been added to the lobby.</summary>
    public event Action<JoinRequestAcceptedData>?  JoinRequestAccepted;
    /// <summary>Requester: the request ended without joining (declined, timed out, host changed, or lobby closed).</summary>
    public event Action<JoinRequestRejectedData>?  JoinRequestRejected;
    /// <summary>
    /// A pending request was withdrawn (requester cancelled or it timed out). Host: for both reasons.
    /// Requester: confirmation of <see cref="CancelJoinRequestAsync"/> (reason <c>Cancelled</c>, on all own sessions).
    /// </summary>
    public event Action<JoinRequestWithdrawnData>? JoinRequestWithdrawn;

    // Social
    /// <summary>A friend's presence changed.</summary>
    public event Action<FriendPresence>?          FriendPresenceChanged;
    /// <summary>Someone sent you a friend request.</summary>
    public event Action<FriendRequestInfo>?       FriendRequestReceived;
    /// <summary>Your friend request was accepted.</summary>
    public event Action<FriendRequestAccepted>?   FriendRequestAccepted;
    /// <summary>Your friend request was declined.</summary>
    public event Action<FriendRequestDeclined>?   FriendRequestDeclined;
    /// <summary>Argument is the request id.</summary>
    public event Action<string>?                  FriendRequestCancelled;
    /// <summary>Argument is the userId of the former friend.</summary>
    public event Action<string>?                  FriendRemoved;
    /// <summary>A new notification arrived.</summary>
    public event Action<HubNotification>?         NotificationReceived;
    /// <summary>Unread notification summary delivered right after connecting.</summary>
    public event Action<NotificationBacklog>?     NotificationBacklogReceived;
    /// <summary>A friend sent you a direct message.</summary>
    public event Action<DirectMessage>?           DirectMessageReceived;
    /// <summary>A message you sent was delivered to an offline recipient.</summary>
    public event Action<DmDeliveredData>?         DirectMessageDelivered;
    /// <summary>A friend read your messages.</summary>
    public event Action<DmReadData>?              DirectMessageRead;
    /// <summary>The read cursor of a chat advanced; also sent to your other sessions so every device clears its badge.</summary>
    public event Action<DmReadState>?             DirectMessageReadStateChanged;
    /// <summary>A friend is typing to you.</summary>
    public event Action<DmTypingData>?            DirectMessageTyping;
    /// <summary>A friend invited you to a lobby.</summary>
    public event Action<LobbyInvite>?             LobbyInviteReceived;
    /// <summary>A lobby invite was cancelled or expired.</summary>
    public event Action<LobbyInviteCancelledData>? LobbyInviteCancelled;
    /// <summary>A friend declined your lobby invite.</summary>
    public event Action<LobbyInviteDeclinedData>?  LobbyInviteDeclined;

    // ─── Fields ───────────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string        _serverUrl;
    private readonly TimeSpan      _timeout;
    private readonly ClientType    _clientType;
    private readonly HttpClient    _http;

    private SocketIOClient.SocketIO? _socket;
    private string? _accessToken;
    private string? _refreshToken;
    private string? _registeredGameId;
    private (string? ClientVersion, string? Platform) _registerOptions;

    // Ensures Disconnected is raised exactly once per connection loss (library event and local close race)
    private readonly ConditionalWeakTable<SocketIOClient.SocketIO, StrongBox<int>> _disconnectRaised = new();
    private long _serverClockOffsetMs;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// <summary>Creates a client. Nothing connects until <see cref="LoginAsync"/> or <see cref="RegisterAsync"/>.</summary>
    public EthernalClient(EthernalClientOptions options)
    {
        _serverUrl = options.ServerUrl.TrimEnd('/');
        _timeout   = options.RequestTimeout;
        _clientType = options.ClientType;
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

    /// <summary>Revoke all refresh tokens of this account and disconnect every session.</summary>
    public async Task LogoutAllAsync(CancellationToken ct = default)
    {
        await AuthedFetchAsync(HttpMethod.Post, "/auth/logout-all", new { }, ct);
        await LogoutLocalAsync();
    }

    /// <summary>Renew the access token and hand it to the live socket (<c>auth:refresh</c>).</summary>
    public async Task RefreshSocketAuthAsync(CancellationToken ct = default)
    {
        await DoRefreshAsync(ct);
        await CallAsync<object?>("auth:refresh", new { token = _accessToken }, ct);
    }

    private async Task LogoutLocalAsync()
    {
        await CloseSocketAsync();
        _accessToken = null;
        _refreshToken = null;
    }

    /// <summary>Log out: revoke the refresh token and disconnect the socket.</summary>
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        if (_refreshToken is not null)
        {
            try { await PostAsync<object?>("/auth/logout", new { refreshToken = _refreshToken }, ct); }
            catch { /* best-effort */ }
        }
        await CloseSocketAsync();
        _accessToken  = null;
        _refreshToken = null;
        _registeredGameId = null;
    }

    /// <summary>
    /// Close the socket without logging out: tokens and the registered game are kept and the hub holds your lobby seat for
    /// the game's reconnect grace period. Raises <see cref="Disconnected"/> (<c>"io client disconnect"</c>) exactly once.
    /// Call <see cref="LoginAsync"/> again to resume.
    /// </summary>
    public Task DisconnectAsync() => CloseSocketAsync();

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
        CancellationToken ct = default,
        ServerMode? serverMode = null,
        string? serverRegion = null) =>
        (await CallAsync<LobbyResult>("createLobby", new
        {
            name, isPrivate, settings = settings ?? [],
            serverPreference = serverMode == null && serverRegion == null ? null : new { mode = serverMode?.Wire(), region = serverRegion },
        }, ct)).Lobby;

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

    /// <summary>
    /// (Host only) Kick a player from the lobby with an optional <paramref name="reason"/> (max. 200 chars, delivered in <see cref="PlayerKicked"/>).
    /// The kick is soft and lives as long as the lobby: the player cannot rejoin (<c>KICKED_FROM_LOBBY</c>) until <see cref="UnkickPlayerAsync"/>.
    /// </summary>
    public Task KickPlayerAsync(string playerId, string? reason = null, CancellationToken ct = default) =>
        CallAsync<object?>("kickPlayer", new { playerId, reason }, ct);

    /// <summary>(Host only) Lift the kick of a player so they may join the lobby again.</summary>
    public Task UnkickPlayerAsync(string playerId, CancellationToken ct = default) =>
        CallAsync<object?>("unkickPlayer", new { playerId }, ct);

    /// <summary>(Host only) Transfer the host role to another player.</summary>
    public Task TransferHostAsync(string playerId, CancellationToken ct = default) =>
        CallAsync<object?>("transferHost", new { playerId }, ct);

    /// <summary>(Host only) Lock the lobby — further joins (including via invite code) require an accepted join request.</summary>
    public Task LockLobbyAsync(CancellationToken ct = default) => CallAsync<object?>("lockLobby", null, ct);

    /// <summary>(Host only) Set the lobby state: <c>"in_progress"</c> or <c>"closed"</c> (wire values of <see cref="LobbyStatus"/>).</summary>
    public Task SetLobbyStateAsync(LobbyStatus state, CancellationToken ct = default) => CallAsync<object?>("setLobbyState", new { state = state.Wire() }, ct);

    /// <summary>(Host only) Unlock the lobby.</summary>
    public Task UnlockLobbyAsync(CancellationToken ct = default) => CallAsync<object?>("unlockLobby", null, ct);

    /// <summary>
    /// Request to join a locked lobby by ID. Resolves once the host accepts (already joined server-side).
    /// Throws <see cref="EthernalException"/> when the request ends otherwise: declined / host changed / lobby closed
    /// (<c>LOBBY_LOCKED</c>), expired (also <c>LOBBY_LOCKED</c>; see <see cref="JoinRequestPendingData.ExpiresAt"/>), or withdrawn
    /// via <see cref="CancelJoinRequestAsync"/> from any session of this user (<c>JOIN_REQUEST_NOT_FOUND</c>).
    /// Inspect <see cref="JoinRequestRejected"/> for the exact reason.
    /// The matching events (<see cref="JoinRequestRejected"/>, <see cref="JoinRequestWithdrawn"/>) are raised as well.
    /// </summary>
    public Task<Lobby> RequestJoinLobbyAsync(string lobbyId) =>
        JoinRequestAsync("requestJoinLobby", new { lobbyId });

    /// <summary>Request to join a locked lobby using its invite code. See <see cref="RequestJoinLobbyAsync"/>.</summary>
    public Task<Lobby> RequestJoinLobbyByCodeAsync(string code) =>
        JoinRequestAsync("requestJoinLobbyByCode", new { code });

    /// <summary>
    /// Withdraw your own pending join request before the host has responded. The hub confirms with
    /// <see cref="JoinRequestWithdrawn"/> (<c>Cancelled</c>) on all your sessions and the host is notified; a pending
    /// <see cref="RequestJoinLobbyAsync"/> call fails immediately. Throws <c>JOIN_REQUEST_NOT_FOUND</c> if there is no such request.
    /// </summary>
    public Task CancelJoinRequestAsync(string lobbyId, CancellationToken ct = default) =>
        CallAsync<object?>("cancelJoinRequest", new { lobbyId }, ct);

    /// <summary>
    /// Pull pending join requests without relying on events: <see cref="JoinRequestsResult.Incoming"/> for the host of a
    /// locked lobby, <see cref="JoinRequestsResult.Outgoing"/> for your own open request. Use it after a reconnect.
    /// </summary>
    public Task<JoinRequestsResult> GetJoinRequestsAsync(CancellationToken ct = default) =>
        CallAsync<JoinRequestsResult>("getJoinRequests", null, ct);

    /// <summary>(Host only) Accept or reject a pending join request (see <see cref="JoinRequestReceived"/>).</summary>
    public Task RespondJoinRequestAsync(string requesterId, bool accept, CancellationToken ct = default) =>
        CallAsync<object?>("respondJoinRequest", new { requesterId, accept }, ct);

    // ─── Relay ────────────────────────────────────────────────────────────────

    /// <summary>Broadcast a typed message to all other players in the lobby; with <paramref name="echo"/> the sender (all own sessions) receives it via <see cref="Message"/> too.</summary>
    public Task SendToLobbyAsync(string type, object? payload = null, CancellationToken ct = default, bool echo = false) =>
        CallAsync<object?>("sendToLobby", new { type, payload, echo = echo ? true : (bool?)null }, ct);

    /// <summary>Send a typed message directly to one player in the lobby; with <paramref name="echo"/> you may target yourself (otherwise <c>CANNOT_TARGET_SELF</c>).</summary>
    public Task SendToPlayerAsync(string playerId, string type, object? payload = null, CancellationToken ct = default, bool echo = false) =>
        CallAsync<object?>("sendToPlayer", new { playerId, type, payload, echo = echo ? true : (bool?)null }, ct);

    /// <summary>Broadcast a binary message to all other players in the lobby; with <paramref name="echo"/> the sender receives it via <see cref="MessageBinary"/> too.</summary>
    public Task SendToLobbyBinaryAsync(int typeCode, byte[] payload, CancellationToken ct = default, bool echo = false)
    {
        if (payload is null) throw new ArgumentNullException(nameof(payload));
        // Optional field must be absent (not null) on the wire for the strict hub validation
        object data = echo ? new { typeCode, payload, echo = true } : new { typeCode, payload };
        return CallAsync<object?>("sendToLobbyBinary", data, ct, binary: true);
    }

    /// <summary>Send a binary message directly to one player in the lobby; with <paramref name="echo"/> you may target yourself.</summary>
    public Task SendToPlayerBinaryAsync(string playerId, int typeCode, byte[] payload, CancellationToken ct = default, bool echo = false)
    {
        if (payload is null) throw new ArgumentNullException(nameof(payload));
        object data = echo ? new { playerId, typeCode, payload, echo = true } : new { playerId, typeCode, payload };
        return CallAsync<object?>("sendToPlayerBinary", data, ct, binary: true);
    }

    // ─── Game Actions ─────────────────────────────────────────────────────────

    /// <summary>Forward a game action to the running game subprocess.</summary>
    public Task SendGameActionAsync(string type, object? payload = null, CancellationToken ct = default) =>
        CallAsync<object?>("gameAction", new { type, payload }, ct);

    // ─── User Data (Socket) ───────────────────────────────────────────────────

    /// <summary>Fetch the current user's own KV-data for a game (socket).</summary>
    public async Task<UserDataEntry[]> GetUserDataAsync(string gameId, CancellationToken ct = default) =>
        (await CallAsync<UserDataPayload>("getUserData", gameId, ct)).Entries;

    /// <summary>
    /// Fetch the KV-data of another player that you may see: <c>friends</c> entries of a friend, <c>lobby</c> entries while you share a lobby of the game.
    /// Anyone else (including non-existent users) gets <c>NOT_ALLOWED</c>. <c>public</c> (leaderboard) entries are never returned; see <see cref="GetLeaderboardAsync"/>.
    /// </summary>
    public async Task<UserDataEntry[]> GetPlayerDataAsync(string playerId, string gameId, CancellationToken ct = default) =>
        (await CallAsync<PlayerDataPayload>("getPlayerData", new { playerId, gameId }, ct)).Entries;

    /// <summary>
    /// Write one own key via socket. Server-scoped keys are read-only for clients (<c>DATA_READ_ONLY</c>);
    /// <see cref="DataVisibility.Public"/> (leaderboard keys) can only be written by a game server (<c>NOT_ALLOWED</c>).
    /// </summary>
    public Task SetUserDataAsync(string gameId, string key, object? value, DataVisibility? visibility = null, CancellationToken ct = default) =>
        CallAsync<object?>("setUserData", new { gameId, key, value, visibility = visibility?.Wire() }, ct);

    /// <summary>Atomically write several own keys via socket.</summary>
    public Task BulkSetUserDataAsync(
        string gameId,
        IEnumerable<(string Key, object? Value, DataVisibility? Visibility)> entries,
        CancellationToken ct = default)
    {
        var data = entries.Select(e => new { key = e.Key, value = e.Value, visibility = e.Visibility?.Wire() });
        return CallAsync<object?>("bulkSetUserData", new { gameId, entries = data }, ct);
    }

    /// <summary>Delete one own key via socket.</summary>
    public Task DeleteUserDataAsync(string gameId, string key, CancellationToken ct = default) =>
        CallAsync<object?>("deleteUserData", new { gameId, key }, ct);

    /// <summary>
    /// Atomically add <paramref name="by"/> to an own numeric key (a missing key counts as 0) and return the new value and version.
    /// Only client-writable keys; never <see cref="DataVisibility.Public"/> (<c>NOT_ALLOWED</c>).
    /// </summary>
    public Task<UserDataWriteResult> IncrementUserDataAsync(string gameId, string key, double by, DataVisibility? visibility = null, CancellationToken ct = default) =>
        CallAsync<UserDataWriteResult>("incrementUserData", new { gameId, key, by, visibility = visibility?.Wire() }, ct);

    /// <summary>
    /// Compare-and-set: write an own key only if its version equals <paramref name="expectedVersion"/> (0 = the key must not exist).
    /// Otherwise throws <c>VERSION_CONFLICT</c> with the current state in <see cref="EthernalException.Conflict"/>.
    /// </summary>
    public Task<UserDataWriteResult> SetUserDataIfAsync(string gameId, string key, object? value, int expectedVersion, DataVisibility? visibility = null, CancellationToken ct = default) =>
        CallAsync<UserDataWriteResult>("setUserDataIf", new { gameId, key, value, expectedVersion, visibility = visibility?.Wire() }, ct);

    /// <summary>
    /// Run 1–100 operations (<see cref="UserDataOp"/>: set, increment, setIf, delete) on own keys all-or-nothing and return one result per operation.
    /// A failing operation (e.g. <c>VERSION_CONFLICT</c>) rolls everything back.
    /// </summary>
    public async Task<UserDataOpResult[]> TransactUserDataAsync(string gameId, IEnumerable<UserDataOp> ops, CancellationToken ct = default) =>
        (await CallAsync<TransactAck>("transactUserData", new { gameId, ops = ops.ToArray() }, ct)).Results;

    // ─── Social ───────────────────────────────────────────────────────────────

    /// <summary>Send a friend request by username. Returns <see cref="FriendRequestResult.RequestSent"/> or <see cref="FriendRequestResult.NoSuchPlayer"/> only.</summary>
    public async Task<FriendRequestResult> RequestFriendByNameAsync(string username, CancellationToken ct = default) =>
        WireEnumConverter<FriendRequestResult>.Parse((await CallAsync<ResultAck>("friend:request", new { username }, ct)).Result);

    /// <summary>Send a friend request to a player in your current lobby.</summary>
    public async Task<FriendRequestResult> RequestFriendFromLobbyAsync(string userId, CancellationToken ct = default) =>
        WireEnumConverter<FriendRequestResult>.Parse((await CallAsync<ResultAck>("friend:request", new { userId }, ct)).Result);

    /// <summary>Accept or decline an incoming friend request.</summary>
    public Task RespondFriendRequestAsync(string requestId, bool accept, CancellationToken ct = default) =>
        CallAsync<object?>("friend:respond", new { requestId, accept }, ct);

    /// <summary>Cancel an outgoing friend request.</summary>
    public Task CancelFriendRequestAsync(string requestId, CancellationToken ct = default) =>
        CallAsync<object?>("friend:cancel", new { requestId }, ct);

    /// <summary>Remove a friend.</summary>
    public Task RemoveFriendAsync(string friendId, CancellationToken ct = default) =>
        CallAsync<object?>("friend:remove", new { friendId }, ct);

    /// <summary>List all friends.</summary>
    public async Task<FriendInfo[]> ListFriendsAsync(CancellationToken ct = default) =>
        (await CallAsync<FriendsAck>("friend:list", null, ct)).Friends;

    /// <summary>List open incoming and outgoing friend requests.</summary>
    public Task<FriendRequestsResult> ListFriendRequestsAsync(CancellationToken ct = default) =>
        CallAsync<FriendRequestsResult>("friend:requests", null, ct);

    /// <summary>Presence of all friends.</summary>
    public async Task<FriendPresence[]> GetFriendsPresenceAsync(CancellationToken ct = default) =>
        (await CallAsync<PresenceAck>("presence:friends", null, ct)).Presence;

    /// <summary>Read own social settings.</summary>
    public async Task<SocialSettings> GetSocialSettingsAsync(CancellationToken ct = default) =>
        (await CallAsync<SettingsAck>("social:getSettings", null, ct)).Settings;

    /// <summary>Update own settings; only non-null arguments are changed. <paramref name="leaderboardVisible"/> controls whether you appear in leaderboards.</summary>
    public async Task<SocialSettings> SetSocialSettingsAsync(OwnPresenceStatus? status = null, bool? showLastSeen = null,
        bool? dmReadReceipts = null, NotificationType[]? mutedNotificationTypes = null, CancellationToken ct = default, bool? leaderboardVisible = null) =>
        (await CallAsync<SettingsAck>("social:setSettings",
            new { status = status?.Wire(), showLastSeen, dmReadReceipts, leaderboardVisible, mutedNotificationTypes = mutedNotificationTypes?.Select(t => t.Wire()) }, ct)).Settings;

    /// <summary>
    /// Block a user (idempotent): removes the friendship, drops pending requests and invites in both directions; their later friend requests are silently ignored.
    /// The block list is private. Errors: <c>CANNOT_TARGET_SELF</c>, <c>USER_NOT_FOUND</c>, <c>BLOCK_LIMIT_REACHED</c>.
    /// </summary>
    public async Task<BlockedUserInfo> BlockUserAsync(string userId, CancellationToken ct = default) =>
        (await CallAsync<BlockAck>("block:add", new { userId }, ct)).Blocked;

    /// <summary>Remove a user from your block list (idempotent). The friendship is not restored.</summary>
    public Task UnblockUserAsync(string userId, CancellationToken ct = default) =>
        CallAsync<object?>("block:remove", new { userId }, ct);

    /// <summary>List the users you blocked.</summary>
    public async Task<BlockedUserInfo[]> GetBlockedUsersAsync(CancellationToken ct = default) =>
        (await CallAsync<BlocksAck>("block:list", null, ct)).Blocks;

    /// <summary>Full social state. Pass the previous etag to get <c>NotModified</c> when nothing changed.</summary>
    public Task<SocialSnapshot> SyncSocialAsync(string? etag = null, CancellationToken ct = default) =>
        CallAsync<SocialSnapshot>("social:sync", new { etag }, ct);

    /// <summary>Look up the lobby of a friend; null when the friend is in none (or it is hidden).</summary>
    public async Task<FriendLobbyInfo?> GetFriendLobbyAsync(string friendId, CancellationToken ct = default) =>
        (await CallAsync<FriendLobbyAck>("social:friendLobby", new { friendId }, ct)).Lobby;

    /// <summary>List notifications, newest first; page with <c>cursor</c>.</summary>
    public Task<NotificationListResult> ListNotificationsAsync(int? limit = null, string? cursor = null, bool? unreadOnly = null, CancellationToken ct = default) =>
        CallAsync<NotificationListResult>("notification:list", new { limit, cursor, unreadOnly }, ct);

    /// <summary>Mark notifications read, by <c>ids</c> or everything up to a timestamp (<c>upTo</c>).</summary>
    public Task<NotificationMarkResult> MarkNotificationsReadAsync(string[]? ids = null, long? upTo = null, CancellationToken ct = default) =>
        CallAsync<NotificationMarkResult>("notification:markRead", new { ids, upTo }, ct);

    /// <summary>Unread and total notification counters.</summary>
    public Task<NotificationCounts> GetNotificationCountsAsync(CancellationToken ct = default) =>
        CallAsync<NotificationCounts>("notification:counts", null, ct);

    /// <summary>Send a direct message to a friend.</summary>
    public async Task<DirectMessage> SendDirectMessageAsync(string toUserId, string text, CancellationToken ct = default) =>
        (await CallAsync<MessageAck>("dm:send", new { toUserId, text }, ct)).Message;

    /// <summary>Load DM history with a friend; page backwards with <c>before</c> = <see cref="DmHistoryResult.NextBefore"/>.</summary>
    public Task<DmHistoryResult> GetDmHistoryAsync(string withUserId, long? before = null, int? limit = null, CancellationToken ct = default) =>
        CallAsync<DmHistoryResult>("dm:history", new { withUserId, before, limit }, ct);

    /// <summary>
    /// Open a chat: returns the last <paramref name="limit"/> (default 10) messages plus the read state from <b>before</b>
    /// opening (<see cref="DmHistoryResult.FirstUnreadSeq"/>, <see cref="DmHistoryResult.UnreadCount"/>, <see cref="DmHistoryResult.PeerLastReadSeq"/>);
    /// afterwards the hub marks everything read and raises <see cref="DirectMessageReadStateChanged"/> on all your sessions.
    /// </summary>
    public Task<DmHistoryResult> OpenDmConversationAsync(string withUserId, int? limit = null, CancellationToken ct = default) =>
        CallAsync<DmHistoryResult>("dm:open", new { withUserId, limit }, ct);

    /// <summary>Pull the chats with unread DMs and the total count (app badge) without events.</summary>
    public Task<DmUnreadResult> GetDmUnreadAsync(CancellationToken ct = default) =>
        CallAsync<DmUnreadResult>("dm:unread", null, ct);

    /// <summary>
    /// Mark incoming messages of a chat read up to <paramref name="upToSeq"/> (default: everything) and return the new
    /// <see cref="DmReadState"/>. Also raises <see cref="DirectMessageReadStateChanged"/> on all your sessions.
    /// </summary>
    public Task<DmReadState> MarkDmReadAsync(string withUserId, long? upToSeq = null, CancellationToken ct = default) =>
        CallAsync<DmReadState>("dm:markRead", new { withUserId, upToSeq }, ct);

    /// <summary>List DM conversations with their last message, unread count and read cursor.</summary>
    public async Task<DmConversation[]> ListConversationsAsync(CancellationToken ct = default) =>
        (await CallAsync<ConversationsAck>("dm:conversations", null, ct)).Conversations;

    /// <summary>Mark a whole conversation read; returns the number of messages marked (see <see cref="MarkDmReadAsync"/> for partial marking and the full read state).</summary>
    public async Task<int> MarkConversationReadAsync(string withUserId, CancellationToken ct = default) =>
        (await MarkDmReadAsync(withUserId, null, ct)).Marked;

    /// <summary>Tell a friend you are typing.</summary>
    public Task SendTypingAsync(string toUserId, CancellationToken ct = default) =>
        CallAsync<object?>("dm:typing", new { toUserId }, ct);

    /// <summary>Invite a friend to your current lobby.</summary>
    public async Task<LobbyInvite> InviteFriendAsync(string friendId, CancellationToken ct = default) =>
        (await CallAsync<InviteAck>("lobby:invite", new { friendId }, ct)).Invite;

    /// <summary>Cancel a lobby invite you sent.</summary>
    public Task CancelLobbyInviteAsync(string inviteId, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:cancelInvite", new { inviteId }, ct);

    /// <summary>Accept a lobby invite and join the lobby.</summary>
    public async Task<Lobby> AcceptLobbyInviteAsync(string inviteId, CancellationToken ct = default) =>
        (await CallAsync<LobbyResult>("lobby:acceptInvite", new { inviteId }, ct)).Lobby;

    /// <summary>Decline a lobby invite.</summary>
    public Task DeclineLobbyInviteAsync(string inviteId, CancellationToken ct = default) =>
        CallAsync<object?>("lobby:declineInvite", new { inviteId }, ct);

    /// <summary>List your open lobby invites.</summary>
    public async Task<LobbyInvite[]> ListLobbyInvitesAsync(CancellationToken ct = default) =>
        (await CallAsync<InvitesAck>("lobby:invites", null, ct)).Invites;

    /// <summary>Join the lobby of a friend; when the lobby is locked only a join request is sent (<see cref="JoinFriendResult.Pending"/>).</summary>
    public Task<JoinFriendResult> JoinFriendAsync(string friendId, CancellationToken ct = default) =>
        CallAsync<JoinFriendResult>("lobby:joinFriend", new { friendId }, ct);

    // ─── User Data (REST) ─────────────────────────────────────────────────────

    /// <summary>Set or update a single KV entry for the current user.</summary>
    public Task SetKeyAsync(string gameId, string key, object? value, DataVisibility? visibility = null, CancellationToken ct = default)
    {
        var body = visibility.HasValue
            ? (object)new { value, visibility = visibility.Value.Wire() }
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
        // The hub expects a bare JSON array as the PATCH body
        var data = entries.Select(e => new { key = e.Key, value = e.Value, visibility = e.Visibility?.Wire() }).ToArray();
        return AuthedFetchAsync(HttpMethod.Patch,
            $"/userdata/{Uri.EscapeDataString(gameId)}",
            data, ct);
    }

    /// <summary>Fetch all own KV entries for a game via REST.</summary>
    public Task<UserDataEntry[]> GetAllDataAsync(string gameId, CancellationToken ct = default) =>
        AuthedFetchAsync<UserDataEntry[]>(HttpMethod.Get,
            $"/userdata/{Uri.EscapeDataString(gameId)}", null, ct);

    /// <summary>
    /// Fetch the leaderboard of a <see cref="DataVisibility.Public"/> numeric key (written by a game server; games without server support have none: <c>NOT_FOUND</c>).
    /// Rows carry their absolute <see cref="LeaderboardEntry.Rank"/>. <paramref name="order"/> is <c>"desc"</c> or <c>"asc"</c>, <paramref name="limit"/> 1–100,
    /// <paramref name="offset"/> skips rows, <paramref name="friendsOnly"/> restricts the board to your friends and yourself (<c>scope=friends</c>).
    /// </summary>
    public Task<LeaderboardEntry[]> GetLeaderboardAsync(
        string gameId, string key,
        string order = "desc", int limit = 10,
        CancellationToken ct = default,
        int? offset = null, bool friendsOnly = false) =>
        AuthedFetchAsync<LeaderboardEntry[]>(HttpMethod.Get,
            LeaderboardPath(gameId, key, order, limit, offset, friendsOnly, null, null), null, ct);

    /// <summary>
    /// Like <see cref="GetLeaderboardAsync"/> but also returns your own row/rank (<see cref="LeaderboardResult.Me"/>, null when unranked; works while you are hidden)
    /// and the total. With <paramref name="around"/> the page is a window of <paramref name="range"/> (1–50, default 5) rows above and below your rank instead of the top
    /// (falls back to the top when unranked).
    /// </summary>
    public Task<LeaderboardResult> GetLeaderboardWithMeAsync(
        string gameId, string key,
        string order = "desc", int limit = 10,
        CancellationToken ct = default,
        int? offset = null, bool friendsOnly = false, bool around = false, int? range = null) =>
        AuthedFetchAsync<LeaderboardResult>(HttpMethod.Get,
            LeaderboardPath(gameId, key, order, limit, offset, friendsOnly, around, range), null, ct);

    private static string LeaderboardPath(string gameId, string key, string order, int limit, int? offset, bool friendsOnly, bool? around, int? range)
    {
        var qs = $"?order={Uri.EscapeDataString(order)}&limit={limit}";
        if (offset is not null) qs += $"&offset={offset}";
        if (friendsOnly) qs += "&scope=friends";
        if (around is not null) qs += around.Value ? "&around=me" : "&me=true";
        if (range is not null) qs += $"&range={range}";
        return $"/leaderboard/{Uri.EscapeDataString(gameId)}/{Uri.EscapeDataString(key)}{qs}";
    }

    // ─── Account ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Change the password. All previously issued tokens (access and refresh) of the account are invalidated and other sessions of the user are
    /// disconnected (<see cref="SessionReplaced"/> with reason <c>PasswordChanged</c>); this client keeps its socket and stores the fresh tokens.
    /// Throws <c>INVALID_CREDENTIALS</c> for a wrong current password.
    /// </summary>
    public async Task<AuthResult> ChangePasswordAsync(string currentPassword, string newPassword, CancellationToken ct = default)
    {
        var result = await AuthedFetchAsync<AuthResult>(HttpMethod.Post, "/auth/password",
            new { currentPassword, newPassword, socketId = _socket?.Id }, ct);
        StoreTokens(result.AccessToken, result.RefreshToken);
        if (_socket is { Connected: true })
        {
            try { await CallAsync<object?>("auth:refresh", new { token = _accessToken }, ct); }
            catch (EthernalException) { /* the socket keeps working until its token expires; the refresh loop handles it */ }
        }
        return result;
    }

    /// <summary>
    /// Permanently delete the account and all its data (GDPR): user data, friendships, DMs, notifications, blocks and lobby membership are purged,
    /// friends receive <c>friend:removed</c> and every session is disconnected. Requires the current <paramref name="password"/>
    /// (<c>INVALID_CREDENTIALS</c> otherwise). Afterwards this client is logged out.
    /// </summary>
    public async Task DeleteAccountAsync(string password, CancellationToken ct = default)
    {
        await AuthedFetchAsync(HttpMethod.Delete, "/auth/account", new { password }, ct);
        await LogoutLocalAsync();
        _registeredGameId = null;
    }

    /// <summary>Download everything the hub stores about you (profile, data, friends, DMs, notifications, settings, blocks) as <see cref="AccountExport"/>.</summary>
    public Task<AccountExport> ExportAccountDataAsync(CancellationToken ct = default) =>
        AuthedFetchAsync<AccountExport>(HttpMethod.Get, "/account/export", null, ct);

    // ─── Internal: Socket ─────────────────────────────────────────────────────

    private async Task ConnectSocketAsync(CancellationToken ct)
    {
        await CloseSocketAsync();

        var socket = new SocketIOClient.SocketIO(_serverUrl, new SocketIOOptions
        {
            Auth           = AuthPayload(),
            ReconnectionAttempts = int.MaxValue,
            ReconnectionDelay    = 1000,
        });

        socket.OnConnected += async (_, _) =>
        {
            if (_disconnectRaised.TryGetValue(socket, out var flag)) flag.Value = 0;
            Connected?.Invoke();
            if (_registeredGameId is not null)
            {
                try { await RegisterGameAsync(_registeredGameId, _registerOptions.ClientVersion, _registerOptions.Platform); }
                catch (Exception ex) { ServerError?.Invoke(ex.Message); }
            }
        };
        socket.OnDisconnected += (_, reason) => RaiseDisconnected(socket, reason);

        socket.OnError += (_, err) => ServerError?.Invoke(err);

        socket.OnReconnectError += async (_, err) =>
        {
            if (err.Message.Contains("INVALID_TOKEN") && _refreshToken is not null)
            {
                try
                {
                    await DoRefreshAsync(CancellationToken.None);
                    // Update auth and reconnect manually
                    socket.Options.Auth = AuthPayload();
                }
                catch
                {
                    AuthError?.Invoke("Token konnte nicht erneuert werden");
                }
            }
        };

        RegisterEvent<HelloPayload>(socket,        "hello",            d =>
        {
            _serverClockOffsetMs = d.ServerTime - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Hello?.Invoke(d);
        });
        RegisterEvent<SessionResumedData>(socket,  "session:resumed",  d => SessionResumed?.Invoke(d));
        RegisterEvent<SessionReplacedData>(socket, "session:replaced", d => SessionReplaced?.Invoke(d));
        RegisterEvent<HubErrorPayload>(socket,     "errorDetail",      d =>
        {
            ErrorDetail?.Invoke(d);
            if (d.Error == ErrorCode.AuthExpired && _refreshToken is not null)
                _ = Task.Run(async () =>
                {
                    try { await RefreshSocketAuthAsync(); }
                    catch { AuthError?.Invoke("Token konnte nicht erneuert werden"); }
                });
        });
        RegisterEvent<Lobby>(socket,     "lobbyCreated",  d => LobbyCreated?.Invoke(d));
        socket.On("lobbyUpdated", response =>
        {
            try
            {
                var lobby = response.GetValue<Lobby>(0);
                LobbyChangeReason? reason = null;
                try { reason = WireEnumConverter<LobbyChangeReason>.Parse(response.GetValue<string?>(1)); } catch { /* reason is optional */ }
                LobbyUpdated?.Invoke(lobby);
                LobbyChanged?.Invoke(lobby, reason);
            }
            catch { /* ignore deserialization errors */ }
        });
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

        // Social
        RegisterEvent<FriendPresence>(socket,          "friend:presence",         d => FriendPresenceChanged?.Invoke(d));
        RegisterEvent<FriendRequestReceivedData>(socket, "friend:requestReceived", d => FriendRequestReceived?.Invoke(d.Request));
        RegisterEvent<FriendRequestAccepted>(socket,   "friend:requestAccepted",  d => FriendRequestAccepted?.Invoke(d));
        RegisterEvent<FriendRequestDeclined>(socket,   "friend:requestDeclined",  d => FriendRequestDeclined?.Invoke(d));
        RegisterEvent<RequestIdData>(socket,           "friend:requestCancelled", d => FriendRequestCancelled?.Invoke(d.RequestId));
        RegisterEvent<UserIdData>(socket,              "friend:removed",          d => FriendRemoved?.Invoke(d.UserId));
        RegisterEvent<HubNotification>(socket,         "notification",            d => NotificationReceived?.Invoke(d));
        RegisterEvent<NotificationBacklog>(socket,     "notification:backlog",    d => NotificationBacklogReceived?.Invoke(d));
        RegisterEvent<DirectMessage>(socket,           "dm:received",             d => DirectMessageReceived?.Invoke(d));
        RegisterEvent<DmDeliveredData>(socket,         "dm:delivered",            d => DirectMessageDelivered?.Invoke(d));
        RegisterEvent<DmReadData>(socket,              "dm:read",                 d => DirectMessageRead?.Invoke(d));
        RegisterEvent<DmReadState>(socket,             "dm:readState",            d => DirectMessageReadStateChanged?.Invoke(d));
        RegisterEvent<DmTypingData>(socket,            "dm:typing",               d => DirectMessageTyping?.Invoke(d));
        RegisterEvent<LobbyInvite>(socket,             "lobby:inviteReceived",    d => LobbyInviteReceived?.Invoke(d));
        RegisterEvent<LobbyInviteCancelledData>(socket, "lobby:inviteCancelled",  d => LobbyInviteCancelled?.Invoke(d));
        RegisterEvent<LobbyInviteDeclinedData>(socket,  "lobby:inviteDeclined",   d => LobbyInviteDeclined?.Invoke(d));

        string? connectError = null;
        socket.OnError += (_, err) => connectError ??= err;

        _socket = socket;
        try
        {
            await socket.ConnectAsync();
            if (!socket.Connected && connectError is not null)
                throw new InvalidOperationException(connectError);
        }
        catch (Exception ex) when (ex is not EthernalException && !ct.IsCancellationRequested)
        {
            _socket = null;
            socket.Dispose();
            var raw = connectError ?? ex.Message;
            if (raw == ErrorCode.RateLimited.Wire())
                raw = await ConnectErrorProbe.RunAsync(_serverUrl, "/", AuthPayload(), TimeSpan.FromSeconds(3)) ?? raw;
            throw EthernalException.FromConnectError(raw, ex);
        }
    }

    private Dictionary<string, string> AuthPayload()
    {
        var auth = new Dictionary<string, string> { ["token"] = $"Bearer {_accessToken}" };
        if (_clientType == ClientType.Panel) auth["clientType"] = "panel";
        return auth;
    }

    private void RaiseDisconnected(SocketIOClient.SocketIO socket, string reason)
    {
        var flag = _disconnectRaised.GetOrCreateValue(socket);
        if (Interlocked.Exchange(ref flag.Value, 1) != 0) return;
        try { Disconnected?.Invoke(reason); }
        catch { /* a faulty subscriber must not break the SDK */ }
    }

    /// <summary>Closes the current socket (if any) and guarantees one <see cref="Disconnected"/> notification for it.</summary>
    private async Task CloseSocketAsync()
    {
        var socket = _socket;
        if (socket is null) return;
        _socket = null;
        try { await socket.DisconnectAsync(); }
        catch { /* already closed */ }
        RaiseDisconnected(socket, "io client disconnect");
    }

    private void RegisterEvent<T>(SocketIOClient.SocketIO socket, string eventName, Action<T> handler)
    {
        socket.On(eventName, response =>
        {
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
            try { handler(response.GetValue<JsonElement>(0)); }
            catch { /* ignore */ }
        });
    }

    private void RegisterBinaryEvent(SocketIOClient.SocketIO socket, string eventName, Action<RelayBinaryMessage> handler)
    {
        socket.On(eventName, response =>
        {

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
    private sealed class TransactAck { [JsonPropertyName("results")] public UserDataOpResult[] Results { get; init; } = []; }
    private sealed class BlockAck { [JsonPropertyName("blocked")] public BlockedUserInfo Blocked { get; init; } = new(); }
    private sealed class BlocksAck { [JsonPropertyName("blocks")] public BlockedUserInfo[] Blocks { get; init; } = []; }
    private sealed class ResultAck { [JsonPropertyName("result")] public string Result { get; init; } = ""; }
    private sealed class FriendsAck { [JsonPropertyName("friends")] public FriendInfo[] Friends { get; init; } = []; }
    private sealed class PresenceAck { [JsonPropertyName("presence")] public FriendPresence[] Presence { get; init; } = []; }
    private sealed class SettingsAck { [JsonPropertyName("settings")] public SocialSettings Settings { get; init; } = new(); }
    private sealed class FriendLobbyAck { [JsonPropertyName("lobby")] public FriendLobbyInfo? Lobby { get; init; } }
    private sealed class MessageAck { [JsonPropertyName("message")] public DirectMessage Message { get; init; } = new(); }
    private sealed class ConversationsAck { [JsonPropertyName("conversations")] public DmConversation[] Conversations { get; init; } = []; }
    private sealed class InviteAck { [JsonPropertyName("invite")] public LobbyInvite Invite { get; init; } = new(); }
    private sealed class InvitesAck { [JsonPropertyName("invites")] public LobbyInvite[] Invites { get; init; } = []; }
    private sealed class FriendRequestReceivedData { [JsonPropertyName("request")] public FriendRequestInfo Request { get; init; } = new(); }
    private sealed class RequestIdData { [JsonPropertyName("requestId")] public string RequestId { get; init; } = ""; }
    private sealed class UserIdData { [JsonPropertyName("userId")] public string UserId { get; init; } = ""; }
    private sealed class JoinRequestAck
    {
        [JsonPropertyName("pending")] public bool   Pending { get; init; }
        [JsonPropertyName("lobby")]   public Lobby? Lobby   { get; init; }
    }

    /// <summary>Emits an event with an ack callback; throws <see cref="EthernalException"/> on a server error or timeout.</summary>
    private async Task<T> CallAsync<T>(string eventName, object? data, CancellationToken ct = default, bool binary = false)
    {
        // The hub validates payloads strictly and rejects explicit nulls for optional fields,
        // so null members are omitted. Binary payloads must stay byte[] (sent as socket.io attachments).
        if (data is not null && !binary) data = JsonSerializer.SerializeToElement(data, JsonOpts);
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
                tcs.TrySetException(err.ToException());
            }
            catch (Exception ex) { tcs.TrySetException(ex); }
        }

        if (data is null) await socket.EmitAsync(eventName, OnAck);
        else await socket.EmitAsync(eventName, OnAck, data);
        return await tcs.Task;
    }

    /// <summary>
    /// Sends a join request and completes with the lobby when the host accepts; throws <see cref="EthernalException"/> on
    /// rejection (declined, timeout, host change, lobby closed) or when the request is withdrawn/cancelled.
    /// </summary>
    private async Task<Lobby> JoinRequestAsync(string emitEvent, object data)
    {
        var outcome = new TaskCompletionSource<Lobby>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? lobbyId = null;
        // Fallback in case the final event never arrives; moved to the hub's expiry once known
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 16_000;

        void OnPending(JoinRequestPendingData d)
        {
            lobbyId = d.LobbyId;
            Interlocked.Exchange(ref deadlineMs, d.ExpiresAt - Interlocked.Read(ref _serverClockOffsetMs) + 3_000);
        }
        void OnAccepted(JoinRequestAcceptedData d) => outcome.TrySetResult(d.Lobby);
        void OnRejected(JoinRequestRejectedData d)
        {
            if (lobbyId is not null && d.LobbyId != lobbyId) return;
            outcome.TrySetException(new EthernalException("LOBBY_LOCKED", $"Beitrittsanfrage abgelehnt ({d.Reason})"));
        }
        void OnWithdrawn(JoinRequestWithdrawnData d)
        {
            if (lobbyId is null || d.LobbyId != lobbyId || d.Reason != JoinRequestWithdrawReason.Cancelled) return;
            outcome.TrySetException(new EthernalException("JOIN_REQUEST_NOT_FOUND", "Beitrittsanfrage zurückgezogen"));
        }

        JoinRequestPending += OnPending;
        JoinRequestAccepted += OnAccepted;
        JoinRequestRejected += OnRejected;
        JoinRequestWithdrawn += OnWithdrawn;
        try
        {
            var ack = (await EmitWithAckAsync(emitEvent, data, CancellationToken.None)).Deserialize<JoinRequestAck>(JsonOpts)!;
            if (ack.Lobby is not null) return ack.Lobby;

            while (true)
            {
                var remaining = Interlocked.Read(ref deadlineMs) - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (remaining <= 0 && !outcome.Task.IsCompleted)
                    throw new EthernalException("TIMEOUT", "Timeout beim Warten auf die Beitrittsanfrage");
                var done = await Task.WhenAny(outcome.Task, Task.Delay((int)Math.Max(remaining, 1)));
                if (done == outcome.Task) return await outcome.Task;
            }
        }
        finally
        {
            JoinRequestPending -= OnPending;
            JoinRequestAccepted -= OnAccepted;
            JoinRequestRejected -= OnRejected;
            JoinRequestWithdrawn -= OnWithdrawn;
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

    /// <summary>Maps a failed REST response (<c>{ error, code }</c>) to an <see cref="EthernalException"/>.</summary>
    private static async Task<EthernalException> ToExceptionAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var text = await res.Content.ReadAsStringAsync(ct);
        ErrorResponse? err = null;
        try { err = JsonSerializer.Deserialize<ErrorResponse>(text, JsonOpts); } catch (JsonException) { /* non-JSON body */ }
        var status = (int)res.StatusCode;
        var retryAfterMs = err?.RetryAfterMs;
        if (retryAfterMs is null && res.Headers.RetryAfter?.Delta is { } delta) retryAfterMs = (int)delta.TotalMilliseconds;
        return new EthernalException(err?.Code ?? $"HTTP_{status}", err?.Error ?? $"HTTP {status}: {text}", retryAfterMs, err?.Data);
    }

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync(path.TrimStart('/'), body, JsonOpts, ct);
        if (!res.IsSuccessStatusCode)
        {
            throw await ToExceptionAsync(res, ct);
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
            // A wrong password (change password / delete account) is no expired token: do not rotate the refresh token
            var failure = await ToExceptionAsync(res, ct);
            if (failure.Error == ErrorCode.InvalidCredentials) { res.Dispose(); throw failure; }
            res.Dispose();
            await DoRefreshAsync(ct);
            res = await SendAuthedAsync(method, path, body, ct);
        }

        using (res)
        {
            if (res.StatusCode == System.Net.HttpStatusCode.NoContent) return default!;
            if (!res.IsSuccessStatusCode)
            {
                throw await ToExceptionAsync(res, ct);
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

    /// <summary>Disconnects and releases all resources.</summary>
    public async ValueTask DisposeAsync()
    {
        var socket = _socket;
        await CloseSocketAsync();
        socket?.Dispose();
        _http.Dispose();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private sealed class ErrorResponse
    {
        [JsonPropertyName("error")] public string? Error { get; init; }
        [JsonPropertyName("code")]  public string? Code  { get; init; }
        [JsonPropertyName("retryAfterMs")] public int? RetryAfterMs { get; init; }
        [JsonPropertyName("data")]  public JsonElement? Data { get; init; }
    }
}
