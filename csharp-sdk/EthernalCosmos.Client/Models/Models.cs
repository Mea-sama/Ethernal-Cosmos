using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

public sealed class LobbyPlayer
{
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    [JsonPropertyName("username")] public string Username { get; init; } = "";
    [JsonPropertyName("isHost")]   public bool   IsHost   { get; init; }
    /// <summary>false while the player is disconnected but still inside the reconnect grace period.</summary>
    [JsonPropertyName("connected")] public bool  Connected { get; init; } = true;
}

public sealed class Lobby
{
    [JsonPropertyName("id")]         public string       Id         { get; init; } = "";
    [JsonPropertyName("gameId")]     public string       GameId     { get; init; } = "";
    [JsonPropertyName("name")]       public string       Name       { get; init; } = "";
    [JsonPropertyName("hostId")]     public string       HostId     { get; init; } = "";
    [JsonPropertyName("players")]    public LobbyPlayer[] Players   { get; init; } = [];
    [JsonPropertyName("maxPlayers")] public int          MaxPlayers { get; init; }
    [JsonPropertyName("status")]     public LobbyStatus  Status     { get; init; } = LobbyStatus.Open;
    [JsonPropertyName("isPrivate")]  public bool         IsPrivate  { get; init; }
    [JsonPropertyName("hosted")]     public bool         Hosted     { get; init; }
    [JsonPropertyName("inviteCode")] public string?      InviteCode { get; init; }
    [JsonPropertyName("settings")]   public Dictionary<string, object?> Settings { get; init; } = [];
    [JsonPropertyName("locked")]     public bool         Locked     { get; init; }
    [JsonPropertyName("createdAt")]  public long         CreatedAt  { get; init; }
    /// <summary>Game server binding (members only); null = no game server.</summary>
    [JsonPropertyName("server")]       public LobbyServerBinding? Server       { get; init; }
    /// <summary>Health of the bound game server; null when no server is bound.</summary>
    [JsonPropertyName("serverStatus")] public LobbyServerStatus?  ServerStatus { get; init; }
    /// <summary>Listings only: a game server is bound.</summary>
    [JsonPropertyName("serverBound")]  public bool?               ServerBound  { get; init; }
    [JsonPropertyName("region")]       public string?             Region       { get; init; }
    [JsonPropertyName("joinable")]     public bool?               Joinable     { get; init; }
}

public sealed class LobbyServerBinding
{
    [JsonPropertyName("serverId")] public string  ServerId { get; init; } = "";
    [JsonPropertyName("region")]   public string? Region   { get; init; }
}

public sealed class UserDataEntry
{
    [JsonPropertyName("key")]        public string         Key        { get; init; } = "";
    [JsonPropertyName("value")]      public object?        Value      { get; init; }
    [JsonPropertyName("visibility")] public DataVisibility Visibility { get; init; } = DataVisibility.Private;
    [JsonPropertyName("updatedAt")]  public long           UpdatedAt  { get; init; }
    [JsonPropertyName("writeScope")] public DataWriteScope WriteScope { get; init; } = DataWriteScope.Client;
    [JsonPropertyName("version")]    public int            Version    { get; init; } = 1;
}

public sealed class PublicUser
{
    [JsonPropertyName("id")]       public string UserId   { get; init; } = "";
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

public sealed class AuthResult
{
    [JsonPropertyName("user")]         public PublicUser User         { get; init; } = new();
    [JsonPropertyName("accessToken")]  public string     AccessToken  { get; init; } = "";
    [JsonPropertyName("refreshToken")] public string     RefreshToken { get; init; } = "";
}

public sealed class LeaderboardEntry
{
    [JsonPropertyName("key")]        public string  Key        { get; init; } = "";
    [JsonPropertyName("value")]      public object? Value      { get; init; }
    [JsonPropertyName("visibility")] public DataVisibility Visibility { get; init; } = DataVisibility.Public;
    [JsonPropertyName("updatedAt")]  public long    UpdatedAt  { get; init; }
}

public sealed class GameStartingData
{
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
    [JsonPropertyName("gameId")]  public string GameId  { get; init; } = "";
}

public sealed class RelayMessage
{
    [JsonPropertyName("from")]    public string  From    { get; init; } = "";
    [JsonPropertyName("type")]    public string  Type    { get; init; } = "";
    [JsonPropertyName("payload")] public object? Payload { get; init; }

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

public sealed class RelayBinaryMessage
{
    [JsonPropertyName("from")]     public string From     { get; init; } = "";
    [JsonPropertyName("typeCode")] public int    TypeCode { get; init; }
    [JsonPropertyName("payload")]  public byte[] Payload  { get; init; } = [];
}

public sealed class UserDataPayload
{
    [JsonPropertyName("gameId")]  public string          GameId  { get; init; } = "";
    [JsonPropertyName("entries")] public UserDataEntry[] Entries { get; init; } = [];
}

public sealed class PlayerDataPayload
{
    [JsonPropertyName("playerId")] public string          PlayerId { get; init; } = "";
    [JsonPropertyName("gameId")]   public string          GameId   { get; init; } = "";
    [JsonPropertyName("entries")]  public UserDataEntry[] Entries  { get; init; } = [];
}

public sealed class PlayerKickedData
{
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
}

public sealed class JoinRequestReceivedData
{
    [JsonPropertyName("lobbyId")]     public string LobbyId     { get; init; } = "";
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    [JsonPropertyName("username")]    public string Username    { get; init; } = "";
}

public sealed class JoinRequestPendingData
{
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
}

public sealed class JoinRequestAcceptedData
{
    [JsonPropertyName("lobby")] public Lobby Lobby { get; init; } = new();
}

public sealed class JoinRequestRejectedData
{
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
    [JsonPropertyName("reason")]  public JoinRequestRejectReason Reason { get; init; }
}

public sealed class JoinRequestWithdrawnData
{
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    [JsonPropertyName("reason")]      public JoinRequestWithdrawReason Reason { get; init; }
}

public sealed class HubErrorPayload
{
    /// <summary>Raw wire code; see <see cref="Error"/> for the enum.</summary>
    [JsonPropertyName("code")]         public string  Code         { get; init; } = "INTERNAL";
    [JsonIgnore] public ErrorCode Error => WireEnumConverter<ErrorCode>.Parse(Code);
    [JsonPropertyName("message")]      public string  Message      { get; init; } = "";
    [JsonPropertyName("event")]        public string? Event        { get; init; }
    [JsonPropertyName("requestId")]    public string? RequestId    { get; init; }
    [JsonPropertyName("retryAfterMs")] public int?    RetryAfterMs { get; init; }
}

/// <summary>Thrown by every SDK call that fails; <see cref="Code"/> is a stable server error code (e.g. GAME_MISMATCH).</summary>
public sealed class EthernalException : Exception
{
    /// <summary>Raw wire code (stable even for codes this SDK version does not know).</summary>
    public string Code { get; }
    /// <summary>Typed error code; <c>Unknown</c> for codes this SDK version does not know.</summary>
    public ErrorCode Error { get; }
    public int? RetryAfterMs { get; }
    public EthernalException(string code, string message, int? retryAfterMs = null) : base(message)
    {
        Code = code;
        Error = WireEnumConverter<ErrorCode>.Parse(code);
        RetryAfterMs = retryAfterMs;
    }
}

public sealed class HelloPayload
{
    [JsonPropertyName("protocolVersion")] public int      ProtocolVersion { get; init; }
    [JsonPropertyName("serverTime")]      public long     ServerTime      { get; init; }
    [JsonPropertyName("sessionId")]       public string   SessionId       { get; init; } = "";
    [JsonPropertyName("capabilities")]    public string[] Capabilities    { get; init; } = [];
    [JsonPropertyName("gameId")]          public string?  GameId          { get; init; }
    [JsonPropertyName("lobbyId")]         public string?  LobbyId         { get; init; }
}

public sealed class SessionState
{
    [JsonPropertyName("sessionId")] public string  SessionId { get; init; } = "";
    [JsonPropertyName("userId")]    public string  UserId    { get; init; } = "";
    [JsonPropertyName("username")]  public string  Username  { get; init; } = "";
    [JsonPropertyName("gameId")]    public string? GameId    { get; init; }
    [JsonPropertyName("lobbyId")]   public string? LobbyId   { get; init; }
}

public sealed class SessionResumedData
{
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
    [JsonPropertyName("lobby")] public Lobby        Lobby { get; init; } = new();
}

public sealed class SessionReplacedData
{
    [JsonPropertyName("reason")] public SessionReplacedReason Reason { get; init; } = SessionReplacedReason.NewSession;
}

public sealed class GameInfo
{
    [JsonPropertyName("id")]               public string  Id               { get; init; } = "";
    [JsonPropertyName("name")]             public string  Name             { get; init; } = "";
    [JsonPropertyName("description")]      public string  Description      { get; init; } = "";
    [JsonPropertyName("maxPlayers")]       public int     MaxPlayers       { get; init; }
    [JsonPropertyName("hosted")]           public bool    Hosted           { get; init; }
    [JsonPropertyName("reconnectGraceMs")] public int?    ReconnectGraceMs { get; init; }
    [JsonPropertyName("minClientVersion")] public string? MinClientVersion { get; init; }
    /// <summary>Whether this game uses game servers (none | optional | required).</summary>
    [JsonPropertyName("serverSupport")]    public ServerSupport ServerSupport { get; init; } = ServerSupport.None;
    [JsonPropertyName("regions")]          public string[]? Regions        { get; init; }
}

public sealed class RegisterGameResult
{
    [JsonPropertyName("game")]  public GameInfo     Game  { get; init; } = new();
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
}

public sealed class SessionStateResult
{
    [JsonPropertyName("state")] public SessionState State { get; init; } = new();
    [JsonPropertyName("lobby")] public Lobby?       Lobby { get; init; }
}
