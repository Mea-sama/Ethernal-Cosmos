using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

/// <summary>A player of a lobby as announced to a game server.</summary>
public sealed class GameServerPlayer
{
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

/// <summary>Handshake answer of the hub after <see cref="GameServerClient.ConnectAsync"/> (also raised again after every automatic reconnect).</summary>
public sealed class GameServerHello
{
    /// <summary>Id of this game server instance.</summary>
    [JsonPropertyName("serverId")] public string  ServerId { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]   public string  GameId   { get; init; } = "";
    /// <summary>True when the hub recognised <see cref="ServerId"/> within <c>SERVER_RESUME_GRACE_MS</c> and kept the lobbies of this server.</summary>
    [JsonPropertyName("resumed")]  public bool    Resumed  { get; init; }
    /// <summary>The lobbies this server still owns (non-empty only when <see cref="Resumed"/>).</summary>
    [JsonPropertyName("lobbies")]  public Lobby[] Lobbies  { get; init; } = [];
}

/// <summary>Public state of a game server as reported by the hub (<see cref="GameServerClient.ReportStatusAsync"/>).</summary>
public sealed class GameServerInfo
{
    /// <summary>Id of the game server.</summary>
    [JsonPropertyName("serverId")]  public string  ServerId  { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]    public string  GameId    { get; init; } = "";
    /// <summary>Region of the server, if any.</summary>
    [JsonPropertyName("region")]    public string? Region    { get; init; }
    /// <summary>Maximum number of simultaneous lobbies.</summary>
    [JsonPropertyName("capacity")]  public int     Capacity  { get; init; }
    /// <summary>Number of lobbies currently assigned.</summary>
    [JsonPropertyName("load")]      public int     Load      { get; init; }
    /// <summary>True while the server accepts no new lobbies.</summary>
    [JsonPropertyName("draining")]  public bool    Draining  { get; init; }
    /// <summary>Whether the server is connected.</summary>
    [JsonPropertyName("connected")] public bool    Connected { get; init; }
    /// <summary>Reported server version.</summary>
    [JsonPropertyName("version")]   public string? Version   { get; init; }
}

/// <summary>
/// The hub asks this server to take over a lobby (<c>lobby:assigned</c>). Decide with <see cref="GameServerClient.AssignmentHandler"/>
/// (default: accept); the event <see cref="GameServerClient.LobbyAssigned"/> is raised after the answer was sent.
/// </summary>
public sealed class AssignInfo
{
    /// <summary>The lobby, including settings and players.</summary>
    [JsonPropertyName("lobby")]            public Lobby                Lobby            { get; init; } = new();
    /// <summary>The players of the lobby.</summary>
    [JsonPropertyName("players")]          public GameServerPlayer[]   Players          { get; init; } = [];
    /// <summary><see cref="LobbyAssignReason.NewLobby"/>: fresh lobby with empty state. <see cref="LobbyAssignReason.ServerRebound"/>: takeover of a lobby whose server was lost (restore state from your own storage).</summary>
    [JsonPropertyName("reason")]           public LobbyAssignReason    Reason           { get; init; }
    /// <summary>Only for <see cref="LobbyAssignReason.ServerRebound"/>: id of the lost server.</summary>
    [JsonPropertyName("previousServerId")] public string?              PreviousServerId { get; init; }
    /// <summary>Only for <see cref="LobbyAssignReason.ServerRebound"/>: when the previous server was lost (Unix ms).</summary>
    [JsonPropertyName("lostAt")]           public long?                LostAt           { get; init; }
}

/// <summary>Answer to an <see cref="AssignInfo"/>.</summary>
public sealed class AssignmentDecision
{
    private AssignmentDecision(bool accept, string? reason) { AcceptLobby = accept; RejectReason = reason; }

    /// <summary>Whether the lobby is accepted.</summary>
    public bool AcceptLobby { get; }
    /// <summary>Optional reason sent to the hub when rejecting.</summary>
    public string? RejectReason { get; }

    /// <summary>Take the lobby.</summary>
    public static AssignmentDecision Accept { get; } = new(true, null);

    /// <summary>Refuse the lobby (e.g. at capacity); the hub then tries the next candidate.</summary>
    public static AssignmentDecision Reject(string? reason = null) => new(false, reason);
}

/// <summary>Payload of <see cref="GameServerClient.LobbyUpdated"/>.</summary>
public sealed class GameServerLobbyUpdate
{
    /// <summary>The updated lobby.</summary>
    [JsonPropertyName("lobby")]  public Lobby              Lobby  { get; init; } = new();
    /// <summary>Why the lobby changed.</summary>
    [JsonPropertyName("reason")] public LobbyChangeReason? Reason { get; init; }
}

/// <summary>Payload of <see cref="GameServerClient.LobbyClosed"/>.</summary>
public sealed class GameServerLobbyClosed
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string            LobbyId { get; init; } = "";
    /// <summary>Why the lobby ended.</summary>
    [JsonPropertyName("reason")]  public LobbyClosedReason Reason  { get; init; }
}

/// <summary>Payload of <see cref="GameServerClient.PlayerJoined"/>.</summary>
public sealed class GameServerPlayerJoined
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]  public string LobbyId  { get; init; } = "";
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

/// <summary>Payload of <see cref="GameServerClient.PlayerLeft"/>.</summary>
public sealed class GameServerPlayerLeft
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string           LobbyId { get; init; } = "";
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]  public string           UserId  { get; init; } = "";
    /// <summary>Why the player left.</summary>
    [JsonPropertyName("reason")]  public PlayerLeftReason Reason  { get; init; }
}

/// <summary>Payload of <see cref="GameServerClient.PlayerDisconnected"/> and <see cref="GameServerClient.PlayerReconnected"/>.</summary>
public sealed class GameServerPlayerPresence
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")] public string LobbyId { get; init; } = "";
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]  public string UserId  { get; init; } = "";
}

/// <summary>A game action sent by a player via <c>SendGameActionAsync</c>, forwarded by the hub (<see cref="GameServerClient.PlayerAction"/>).</summary>
public sealed class PlayerAction
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]  public string      LobbyId { get; init; } = "";
    /// <summary>Id of the acting user.</summary>
    [JsonPropertyName("userId")]   public string      UserId  { get; init; } = "";
    /// <summary>Action type chosen by the game client.</summary>
    [JsonPropertyName("type")]     public string      Type    { get; init; } = "";
    /// <summary>Action payload (JSON).</summary>
    [JsonPropertyName("payload")]  public JsonElement Payload { get; init; }

    /// <summary>Deserializes <see cref="Payload"/> to <typeparamref name="T"/>.</summary>
    public T? PayloadAs<T>(JsonSerializerOptions? options = null) =>
        Payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? default : Payload.Deserialize<T>(options ?? new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
}

/// <summary>One entry of <see cref="GameServerClient.BulkSetDataAsync"/>.</summary>
/// <param name="Key">Data key.</param>
/// <param name="Value">Value (JSON).</param>
/// <param name="Visibility">Visibility; null keeps the existing one (new keys: private). <see cref="DataVisibility.Public"/> marks a leaderboard key.</param>
/// <param name="WriteScope">Write scope; <see cref="DataWriteScope.Server"/> locks the key for client writes.</param>
public sealed record GameServerDataEntry(string Key, object? Value, DataVisibility? Visibility = null, DataWriteScope? WriteScope = null);
