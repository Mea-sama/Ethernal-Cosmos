using System.Text.Json.Serialization;

namespace EthernalCosmos.ScoreRush.Shared;

public static class ScoreRushGame
{
    public const string GameId = "score-rush-2p";
    public const string LeaderboardKey = "round.best_score";
    public const string InputActionType = "input";

    public const float ArenaWidth = 1200f;
    public const float ArenaHeight = 700f;
    public const float PlayerRadius = 16f;
    public const float PickupRadius = 8f;
    public const float PlayerSpeed = 240f;

    public const int StartPickups = 20;
    public const float SpawnPerSecond = 2f;
    public const int DefaultRoundSeconds = 90;
    public const int MaxPickups = 80;

    public const string RoundSecondsSettingKey = "roundSeconds";
    public const string SpawnRateSettingKey = "spawnRate";
    public const string InitialPickupsSettingKey = "initialPickups";
}

public sealed class PlayerInputMessage
{
    [JsonPropertyName("x")] public float X { get; init; }
    [JsonPropertyName("y")] public float Y { get; init; }
}

public sealed class ScoreRushPlayerView
{
    [JsonPropertyName("userId")] public string UserId { get; init; } = "";
    [JsonPropertyName("username")] public string Username { get; init; } = "";
    [JsonPropertyName("x")] public float X { get; init; }
    [JsonPropertyName("y")] public float Y { get; init; }
    [JsonPropertyName("score")] public int Score { get; init; }
    [JsonPropertyName("connected")] public bool Connected { get; init; }
}

public sealed class ScoreRushPickupView
{
    [JsonPropertyName("id")] public int Id { get; init; }
    [JsonPropertyName("x")] public float X { get; init; }
    [JsonPropertyName("y")] public float Y { get; init; }
    [JsonPropertyName("value")] public int Value { get; init; }
}

public sealed class ScoreRushSnapshot
{
    [JsonPropertyName("phase")] public string Phase { get; init; } = "waiting";
    [JsonPropertyName("roundSeconds")] public int RoundSeconds { get; init; } = ScoreRushGame.DefaultRoundSeconds;
    [JsonPropertyName("timeLeftSec")] public float TimeLeftSec { get; init; }
    [JsonPropertyName("serverTimeMs")] public long ServerTimeMs { get; init; }
    [JsonPropertyName("arenaWidth")] public float ArenaWidth { get; init; } = ScoreRushGame.ArenaWidth;
    [JsonPropertyName("arenaHeight")] public float ArenaHeight { get; init; } = ScoreRushGame.ArenaHeight;
    [JsonPropertyName("players")] public ScoreRushPlayerView[] Players { get; init; } = [];
    [JsonPropertyName("pickups")] public ScoreRushPickupView[] Pickups { get; init; } = [];
    [JsonPropertyName("status")] public string? Status { get; init; }
}

public sealed class ScoreRushRoundResult
{
    [JsonPropertyName("winnerUserId")] public string? WinnerUserId { get; init; }
    [JsonPropertyName("winnerUsername")] public string? WinnerUsername { get; init; }
    [JsonPropertyName("reason")] public string Reason { get; init; } = "time";
    [JsonPropertyName("scores")] public ScoreRushPlayerView[] Scores { get; init; } = [];
}
