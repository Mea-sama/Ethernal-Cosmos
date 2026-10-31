using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

public enum LobbyStatus { Open, Full, Closed }

public enum DataVisibility { Private, Lobby, Public }

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
    [JsonPropertyName("status")]     public string       Status     { get; init; } = "open";
    [JsonPropertyName("isPrivate")]  public bool         IsPrivate  { get; init; }
    [JsonPropertyName("hosted")]     public bool         Hosted     { get; init; }
    [JsonPropertyName("inviteCode")] public string?      InviteCode { get; init; }
    [JsonPropertyName("settings")]   public Dictionary<string, object?> Settings { get; init; } = [];
    [JsonPropertyName("locked")]     public bool         Locked     { get; init; }
    [JsonPropertyName("createdAt")]  public long         CreatedAt  { get; init; }
}

public sealed class UserDataEntry
{
    [JsonPropertyName("key")]        public string         Key        { get; init; } = "";
    [JsonPropertyName("value")]      public object?        Value      { get; init; }
    [JsonPropertyName("visibility")] public string         Visibility { get; init; } = "private";
    [JsonPropertyName("updatedAt")]  public long           UpdatedAt  { get; init; }
    [JsonPropertyName("writeScope")] public string         WriteScope { get; init; } = "client";
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
    [JsonPropertyName("visibility")] public string  Visibility { get; init; } = "public";
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

/// <summary>Reason a join request ended without the requester joining.</summary>
public enum JoinRequestRejectReason
{
    Declined,
    Timeout,
    HostChanged,
    LobbyClosed,
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
    /// <summary>One of: "declined", "timeout", "host_changed", "lobby_closed" — see <see cref="JoinRequestRejectReason"/>.</summary>
    [JsonPropertyName("reason")]  public string Reason  { get; init; } = "";
}

public sealed class JoinRequestWithdrawnData
{
    [JsonPropertyName("requesterId")] public string RequesterId { get; init; } = "";
    [JsonPropertyName("reason")]      public string Reason      { get; init; } = "";
}

public sealed class PresenceUser
{
    [JsonPropertyName("userId")]      public string  UserId      { get; init; } = "";
    [JsonPropertyName("username")]    public string  Username    { get; init; } = "";
    /// <summary>Lobby the user is currently in. Null when in Hub without a lobby.</summary>
    [JsonPropertyName("lobbyId")]     public string? LobbyId     { get; init; }
    /// <summary>Game the user is playing. Null when not in a game.</summary>
    [JsonPropertyName("gameId")]      public string? GameId      { get; init; }
    /// <summary>Status of the lobby the user is in. Only set when LobbyId is present.
    /// "open" = joinable, "full" / "closed" = not joinable.</summary>
    [JsonPropertyName("lobbyStatus")] public string? LobbyStatus { get; init; }
}

public sealed class HubErrorPayload
{
    [JsonPropertyName("code")]         public string  Code         { get; init; } = "INTERNAL";
    [JsonPropertyName("message")]      public string  Message      { get; init; } = "";
    [JsonPropertyName("event")]        public string? Event        { get; init; }
    [JsonPropertyName("requestId")]    public string? RequestId    { get; init; }
    [JsonPropertyName("retryAfterMs")] public int?    RetryAfterMs { get; init; }
}

/// <summary>Thrown by every SDK call that fails; <see cref="Code"/> is a stable server error code (e.g. GAME_MISMATCH).</summary>
public sealed class EthernalException : Exception
{
    public string Code { get; }
    public int? RetryAfterMs { get; }
    public EthernalException(string code, string message, int? retryAfterMs = null) : base(message)
    {
        Code = code;
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
    [JsonPropertyName("reason")] public string Reason { get; init; } = "new_session";
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
