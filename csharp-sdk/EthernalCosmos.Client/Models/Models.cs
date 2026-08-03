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
    [JsonPropertyName("createdAt")]  public long         CreatedAt  { get; init; }
}

public sealed class UserDataEntry
{
    [JsonPropertyName("key")]        public string         Key        { get; init; } = "";
    [JsonPropertyName("value")]      public object?        Value      { get; init; }
    [JsonPropertyName("visibility")] public string         Visibility { get; init; } = "private";
    [JsonPropertyName("updatedAt")]  public long           UpdatedAt  { get; init; }
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
