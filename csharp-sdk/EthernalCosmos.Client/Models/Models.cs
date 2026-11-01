using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

/// <summary>A player inside a lobby.</summary>
public sealed class LobbyPlayer
{
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")] public string Username { get; init; } = "";
    /// <summary>Whether this player is the lobby host.</summary>
    [JsonPropertyName("isHost")]   public bool   IsHost   { get; init; }
    /// <summary>false while the player is disconnected but still inside the reconnect grace period.</summary>
    [JsonPropertyName("connected")] public bool  Connected { get; init; } = true;
}

/// <summary>A lobby as seen by a member or in a listing.</summary>
public sealed class Lobby
{
    /// <summary>Unique id.</summary>
    [JsonPropertyName("id")]         public string       Id         { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]     public string       GameId     { get; init; } = "";
    /// <summary>Display name.</summary>
    [JsonPropertyName("name")]       public string       Name       { get; init; } = "";
    /// <summary>User id of the lobby host.</summary>
    [JsonPropertyName("hostId")]     public string       HostId     { get; init; } = "";
    /// <summary>Players currently in the lobby.</summary>
    [JsonPropertyName("players")]    public LobbyPlayer[] Players   { get; init; } = [];
    /// <summary>Maximum number of players.</summary>
    [JsonPropertyName("maxPlayers")] public int          MaxPlayers { get; init; }
    /// <summary>Current status.</summary>
    [JsonPropertyName("status")]     public LobbyStatus  Status     { get; init; } = LobbyStatus.Open;
    /// <summary>Whether the lobby is hidden from public listings.</summary>
    [JsonPropertyName("isPrivate")]  public bool         IsPrivate  { get; init; }
    /// <summary>Whether the game logic runs on the hub (hosted game process).</summary>
    [JsonPropertyName("hosted")]     public bool         Hosted     { get; init; }
    /// <summary>Short code for joining the lobby; only visible to members.</summary>
    [JsonPropertyName("inviteCode")] public string?      InviteCode { get; init; }
    /// <summary>Free-form lobby settings.</summary>
    [JsonPropertyName("settings")]   public Dictionary<string, object?> Settings { get; init; } = [];
    /// <summary>Whether joining requires host approval.</summary>
    [JsonPropertyName("locked")]     public bool         Locked     { get; init; }
    /// <summary>Creation time (Unix ms).</summary>
    [JsonPropertyName("createdAt")]  public long         CreatedAt  { get; init; }
    /// <summary>Game server binding (members only); null = no game server.</summary>
    [JsonPropertyName("server")]       public LobbyServerBinding? Server       { get; init; }
    /// <summary>Health of the bound game server; null when no server is bound.</summary>
    [JsonPropertyName("serverStatus")] public LobbyServerStatus?  ServerStatus { get; init; }
    /// <summary>Listings only: a game server is bound.</summary>
    [JsonPropertyName("serverBound")]  public bool?               ServerBound  { get; init; }
    /// <summary>Region of the game server, if any.</summary>
    [JsonPropertyName("region")]       public string?             Region       { get; init; }
    /// <summary>Whether the lobby can currently be joined.</summary>
    [JsonPropertyName("joinable")]     public bool?               Joinable     { get; init; }
}

/// <summary>The game server a lobby is bound to.</summary>
public sealed class LobbyServerBinding
{
    /// <summary>Id of the bound game server.</summary>
    [JsonPropertyName("serverId")] public string  ServerId { get; init; } = "";
    /// <summary>Region of the game server, if any.</summary>
    [JsonPropertyName("region")]   public string? Region   { get; init; }
}

/// <summary>One stored user-data entry.</summary>
public sealed class UserDataEntry
{
    /// <summary>Data key.</summary>
    [JsonPropertyName("key")]        public string         Key        { get; init; } = "";
    /// <summary>Stored value (JSON).</summary>
    [JsonPropertyName("value")]      public object?        Value      { get; init; }
    /// <summary>Who may read the entry.</summary>
    [JsonPropertyName("visibility")] public DataVisibility Visibility { get; init; } = DataVisibility.Private;
    /// <summary>Last update time (Unix ms).</summary>
    [JsonPropertyName("updatedAt")]  public long           UpdatedAt  { get; init; }
    /// <summary>Who may write the entry.</summary>
    [JsonPropertyName("writeScope")] public DataWriteScope WriteScope { get; init; } = DataWriteScope.Client;
    /// <summary>Entry version, incremented on every write.</summary>
    [JsonPropertyName("version")]    public int            Version    { get; init; } = 1;
}

/// <summary>Public identity of a user.</summary>
public sealed class PublicUser
{
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("id")]       public string UserId   { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

/// <summary>Result of register/login: user plus tokens.</summary>
public sealed class AuthResult
{
    /// <summary>The user.</summary>
    [JsonPropertyName("user")]         public PublicUser User         { get; init; } = new();
    /// <summary>Short-lived access token (JWT).</summary>
    [JsonPropertyName("accessToken")]  public string     AccessToken  { get; init; } = "";
    /// <summary>Long-lived, rotating refresh token.</summary>
    [JsonPropertyName("refreshToken")] public string     RefreshToken { get; init; } = "";
}

/// <summary>One leaderboard row.</summary>
public sealed class LeaderboardEntry
{
    /// <summary>Absolute 1-based rank (ties are ordered by earlier update, then user id).</summary>
    [JsonPropertyName("rank")]       public int     Rank       { get; init; }
    /// <summary>Id of the ranked user.</summary>
    [JsonPropertyName("userId")]     public string  UserId     { get; init; } = "";
    /// <summary>Display name of the ranked user.</summary>
    [JsonPropertyName("username")]   public string  Username   { get; init; } = "";
    /// <summary>Stored numeric value (JSON).</summary>
    [JsonPropertyName("value")]      public object? Value      { get; init; }
    /// <summary>Last update time (Unix ms).</summary>
    [JsonPropertyName("updatedAt")]  public long    UpdatedAt  { get; init; }
}

/// <summary>Leaderboard page including the caller's own row (<see cref="EthernalClient.GetLeaderboardWithMeAsync"/>).</summary>
public sealed class LeaderboardResult
{
    /// <summary>Rows of the requested page or window.</summary>
    [JsonPropertyName("entries")] public LeaderboardEntry[] Entries { get; init; } = [];
    /// <summary>The caller's own row and rank (also while hidden via <c>LeaderboardVisible</c>); null when unranked.</summary>
    [JsonPropertyName("me")]      public LeaderboardEntry?  Me      { get; init; }
    /// <summary>Number of visible ranked players in the selected scope.</summary>
    [JsonPropertyName("total")]   public int                Total   { get; init; }
}

/// <summary>Payload of <c>GameStarting</c>.</summary>
public sealed class GameStartingData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]  public string GameId  { get; init; } = "";
}

/// <summary>A text/JSON relay message from another player.</summary>
public sealed class RelayMessage
{
    /// <summary>User id of the sender.</summary>
    [JsonPropertyName("from")]    public string  From    { get; init; } = "";
    /// <summary>Per-lobby sequence number assigned by the hub.</summary>
    [JsonPropertyName("seq")]     public long?   Seq     { get; init; }
    /// <summary>Message type.</summary>
    [JsonPropertyName("type")]    public string  Type    { get; init; } = "";
    /// <summary>Message payload.</summary>
    [JsonPropertyName("payload")] public object? Payload { get; init; }

    /// <summary>Deserializes <see cref="Payload"/> to <typeparamref name="T"/>.</summary>
    public T? PayloadAs<T>(JsonSerializerOptions? options = null)
    {
        if (Payload is null)
        {
            return default;
        }

        if (Payload is T typed)
        {
            return typed;
        }

        if (Payload is JsonElement element)
        {
            return element.Deserialize<T>(options);
        }

        var json = JsonSerializer.Serialize(Payload, options);
        return JsonSerializer.Deserialize<T>(json, options);
    }

    /// <summary>Like <see cref="PayloadAs{T}"/> but returns false instead of throwing.</summary>
    public bool TryPayloadAs<T>(out T? payload, JsonSerializerOptions? options = null)
    {
        try
        {
            payload = PayloadAs<T>(options);
            return true;
        }
        catch
        {
            payload = default;
            return false;
        }
    }
}

/// <summary>A binary relay message from another player.</summary>
public sealed class RelayBinaryMessage
{
    /// <summary>User id of the sender.</summary>
    [JsonPropertyName("from")]     public string From     { get; init; } = "";
    /// <summary>Per-lobby sequence number assigned by the hub.</summary>
    [JsonPropertyName("seq")]      public long?  Seq      { get; init; }
    /// <summary>Application-defined numeric message type.</summary>
    [JsonPropertyName("typeCode")] public int    TypeCode { get; init; }
    /// <summary>Message payload.</summary>
    [JsonPropertyName("payload")]  public byte[] Payload  { get; init; } = [];
}

/// <summary>Own user data for a game.</summary>
public sealed class UserDataPayload
{
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]  public string          GameId  { get; init; } = "";
    /// <summary>The data entries.</summary>
    [JsonPropertyName("entries")] public UserDataEntry[] Entries { get; init; } = [];
}

/// <summary>Visible data of another player.</summary>
public sealed class PlayerDataPayload
{
    /// <summary>User id of the player.</summary>
    [JsonPropertyName("playerId")] public string          PlayerId { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]   public string          GameId   { get; init; } = "";
    /// <summary>The data entries.</summary>
    [JsonPropertyName("entries")]  public UserDataEntry[] Entries  { get; init; } = [];
}

/// <summary>Payload of <c>PlayerKicked</c>.</summary>
public sealed class PlayerKickedData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string  LobbyId { get; init; } = "";
    /// <summary>Optional reason given by the host or game server.</summary>
    [JsonPropertyName("reason")]  public string? Reason  { get; init; }
}

/// <summary>A player asked the host to join.</summary>
public sealed class JoinRequestReceivedData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]     public string LobbyId     { get; init; } = "";
    /// <summary>User id of the player asking to join.</summary>
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")]    public string Username    { get; init; } = "";
    /// <summary>When the hub auto-rejects the request (Unix ms).</summary>
    [JsonPropertyName("expiresAt")]   public long   ExpiresAt   { get; init; }
}

/// <summary>Own join request is waiting for the host.</summary>
public sealed class JoinRequestPendingData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]   public string LobbyId   { get; init; } = "";
    /// <summary>When the hub auto-rejects the request (Unix ms).</summary>
    [JsonPropertyName("expiresAt")] public long   ExpiresAt { get; init; }
}

/// <summary>Own join request was accepted.</summary>
public sealed class JoinRequestAcceptedData
{
    /// <summary>The lobby.</summary>
    [JsonPropertyName("lobby")] public Lobby Lobby { get; init; } = new();
}

/// <summary>Own join request was rejected.</summary>
public sealed class JoinRequestRejectedData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
    /// <summary>Why this happened.</summary>
    [JsonPropertyName("reason")]  public JoinRequestRejectReason Reason { get; init; }
}

/// <summary>A join request was withdrawn. Sent to the host and, for <see cref="JoinRequestWithdrawReason.Cancelled"/>, also to all sessions of the requester.</summary>
public sealed class JoinRequestWithdrawnData
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]     public string LobbyId     { get; init; } = "";
    /// <summary>User id of the player asking to join.</summary>
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    /// <summary>Why this happened.</summary>
    [JsonPropertyName("reason")]      public JoinRequestWithdrawReason Reason { get; init; }
}

/// <summary>A pending join request, as returned by <see cref="EthernalClient.GetJoinRequestsAsync"/>.</summary>
public sealed class JoinRequestInfo
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]     public string LobbyId     { get; init; } = "";
    /// <summary>User id of the player asking to join.</summary>
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    /// <summary>Display name of the requester.</summary>
    [JsonPropertyName("username")]    public string Username    { get; init; } = "";
    /// <summary>When the hub auto-rejects the request (Unix ms).</summary>
    [JsonPropertyName("expiresAt")]   public long   ExpiresAt   { get; init; }
}

/// <summary>Pending join requests of the caller (pull API).</summary>
public sealed class JoinRequestsResult
{
    /// <summary>Requests waiting for the caller as host of a locked lobby.</summary>
    [JsonPropertyName("incoming")] public JoinRequestInfo[] Incoming { get; init; } = [];
    /// <summary>The caller's own open request; null when there is none.</summary>
    [JsonPropertyName("outgoing")] public JoinRequestInfo?  Outgoing { get; init; }
}

/// <summary>Error payload of the <c>error</c> socket event.</summary>
public sealed class HubErrorPayload
{
    /// <summary>Raw wire code; see <see cref="Error"/> for the enum.</summary>
    [JsonPropertyName("code")]         public string  Code         { get; init; } = "INTERNAL";
    /// <summary>Typed error code.</summary>
    [JsonIgnore] public ErrorCode Error => WireEnumConverter<ErrorCode>.Parse(Code);
    /// <summary>Human-readable message.</summary>
    [JsonPropertyName("message")]      public string  Message      { get; init; } = "";
    /// <summary>Socket event that caused the error.</summary>
    [JsonPropertyName("event")]        public string? Event        { get; init; }
    /// <summary>Id of the request.</summary>
    [JsonPropertyName("requestId")]    public string? RequestId    { get; init; }
    /// <summary>Suggested wait before retrying, in milliseconds.</summary>
    [JsonPropertyName("retryAfterMs")] public int?    RetryAfterMs { get; init; }
    /// <summary>Additional error data, e.g. <c>{ "current": ... }</c> for <c>VERSION_CONFLICT</c>.</summary>
    [JsonPropertyName("data")]         public JsonElement? Data    { get; init; }

    internal EthernalException ToException() => new(Code, Message, RetryAfterMs, Data);
}

/// <summary>Thrown by every SDK call that fails; <see cref="Code"/> is a stable server error code (e.g. GAME_MISMATCH).</summary>
public sealed class EthernalException : Exception
{
    /// <summary>Maps the first socket error / exception of a failed handshake to the hub's error code (<c>connect_error.message</c>, <c>data.retryAfterMs</c>).</summary>
    internal static EthernalException FromConnectError(string? raw, Exception inner)
    {
        if (raw is not null)
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;
                var data = root.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object ? d.Clone() : (JsonElement?)null;
                var message = root.TryGetProperty("message", out var m) ? m.GetString() : null;
                var code = data is { } dd && dd.TryGetProperty("code", out var c) && c.GetString() is { } cs ? cs : message ?? raw;
                var retry = data is { } rd && rd.TryGetProperty("retryAfterMs", out var r) && r.TryGetInt32(out var ms) ? ms : (int?)null;
                return new EthernalException(code, data is { } md && md.TryGetProperty("message", out var dm) ? dm.GetString() ?? code : code, retry, data);
            }
            catch (JsonException)
            {
                return new EthernalException(raw.Trim('"'), raw);
            }
        }
        return new EthernalException("CONNECT_FAILED", inner.Message);
    }

    /// <summary>Raw wire code (stable even for codes this SDK version does not know).</summary>
    public string Code { get; }
    /// <summary>Typed error code; <c>Unknown</c> for codes this SDK version does not know.</summary>
    public ErrorCode Error { get; }
    /// <summary>For <see cref="ErrorCode.RateLimited"/>: the earliest time to retry, in milliseconds (REST, socket acks and connect errors).</summary>
    public int? RetryAfterMs { get; }
    /// <summary>Raw additional error data of the hub (<c>error.data</c>), if any.</summary>
    public JsonElement? ErrorData { get; }
    /// <summary>
    /// For <see cref="ErrorCode.VersionConflict"/>: the current stored state of the key (<see cref="VersionConflict.Current"/> is null when the key does not exist).
    /// Null for every other error.
    /// </summary>
    public VersionConflict? Conflict { get; }
    /// <summary>Creates an exception; <see cref="Error"/> is derived from <paramref name="code"/>.</summary>
    public EthernalException(string code, string message, int? retryAfterMs = null, JsonElement? data = null) : base(message)
    {
        Code = code;
        Error = WireEnumConverter<ErrorCode>.Parse(code);
        RetryAfterMs = retryAfterMs;
        ErrorData = data is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } ? data : null;
        if (Error == ErrorCode.VersionConflict && ErrorData is { ValueKind: JsonValueKind.Object } d)
        {
            try { Conflict = d.Deserialize<VersionConflict>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true }); }
            catch (JsonException) { /* malformed data: Conflict stays null */ }
        }
    }
}

/// <summary>Handshake data sent by the hub after connecting.</summary>
public sealed class HelloPayload
{
    /// <summary>Hub protocol version.</summary>
    [JsonPropertyName("protocolVersion")] public int      ProtocolVersion { get; init; }
    /// <summary>Hub time (Unix ms).</summary>
    [JsonPropertyName("serverTime")]      public long     ServerTime      { get; init; }
    /// <summary>Id of the session.</summary>
    [JsonPropertyName("sessionId")]       public string   SessionId       { get; init; } = "";
    /// <summary>Capabilities announced by the hub.</summary>
    [JsonPropertyName("capabilities")]    public string[] Capabilities    { get; init; } = [];
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]          public string?  GameId          { get; init; }
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]         public string?  LobbyId         { get; init; }
}

/// <summary>Identity and position of the current session.</summary>
public sealed class SessionState
{
    /// <summary>Id of the session.</summary>
    [JsonPropertyName("sessionId")] public string  SessionId { get; init; } = "";
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]    public string  UserId    { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")]  public string  Username  { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]    public string? GameId    { get; init; }
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]   public string? LobbyId   { get; init; }
}

/// <summary>Payload of <c>SessionResumed</c>.</summary>
public sealed class SessionResumedData
{
    /// <summary>The session state.</summary>
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
    /// <summary>The lobby.</summary>
    [JsonPropertyName("lobby")] public Lobby        Lobby { get; init; } = new();
}

/// <summary>Payload of <c>SessionReplaced</c>.</summary>
public sealed class SessionReplacedData
{
    /// <summary>Why this happened.</summary>
    [JsonPropertyName("reason")] public SessionReplacedReason Reason { get; init; } = SessionReplacedReason.NewSession;
}

/// <summary>A registered game and its hub-side settings.</summary>
public sealed class GameInfo
{
    /// <summary>Unique id.</summary>
    [JsonPropertyName("id")]               public string  Id               { get; init; } = "";
    /// <summary>Display name.</summary>
    [JsonPropertyName("name")]             public string  Name             { get; init; } = "";
    /// <summary>Game description.</summary>
    [JsonPropertyName("description")]      public string  Description      { get; init; } = "";
    /// <summary>Maximum number of players.</summary>
    [JsonPropertyName("maxPlayers")]       public int     MaxPlayers       { get; init; }
    /// <summary>Whether the game logic runs on the hub (hosted game process).</summary>
    [JsonPropertyName("hosted")]           public bool    Hosted           { get; init; }
    /// <summary>Reconnect grace period in milliseconds.</summary>
    [JsonPropertyName("reconnectGraceMs")] public int?    ReconnectGraceMs { get; init; }
    /// <summary>Minimum client version the hub accepts.</summary>
    [JsonPropertyName("minClientVersion")] public string? MinClientVersion { get; init; }
    /// <summary>Whether this game uses game servers (none | optional | required).</summary>
    [JsonPropertyName("serverSupport")]    public ServerSupport ServerSupport { get; init; } = ServerSupport.None;
    /// <summary>Supported game server regions.</summary>
    [JsonPropertyName("regions")]          public string[]? Regions        { get; init; }
}

/// <summary>Result of <c>RegisterGameAsync</c>.</summary>
public sealed class RegisterGameResult
{
    /// <summary>The registered game.</summary>
    [JsonPropertyName("game")]  public GameInfo     Game  { get; init; } = new();
    /// <summary>The session state.</summary>
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
}

/// <summary>Result of <c>GetSessionStateAsync</c>.</summary>
public sealed class SessionStateResult
{
    /// <summary>The session state.</summary>
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
    /// <summary>The lobby.</summary>
    [JsonPropertyName("lobby")] public Lobby?       Lobby { get; init; }
}
