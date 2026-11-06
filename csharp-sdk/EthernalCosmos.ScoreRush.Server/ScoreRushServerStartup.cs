using System.Text.Json;
using EthernalCosmos.Client;
using EthernalCosmos.ScoreRush.Shared;

namespace EthernalCosmos.ScoreRush.Server;

public sealed record ScoreRushStartupResult(bool IsValid, string Message, GameServerClientOptions? Options)
{
    public static ScoreRushStartupResult Valid(GameServerClientOptions options) =>
        new(true, "Startup configuration is valid.", options);

    public static ScoreRushStartupResult Invalid(string message) =>
        new(false, message, null);
}

public static class ScoreRushServerStartup
{
    private const string DefaultConfigFileName = "score-rush-server.json";
    private const string DefaultConfigDirectory = ".secrets";

    public static ScoreRushStartupResult ValidateArgs(string[] rawArgs)
    {
        var argsMap = ParseArgs(rawArgs);
        var configPath = Arg(argsMap, "configPath", Arg(argsMap, "config", Arg(argsMap, "configFile", EnvOrDefault(DefaultConfigFilePath(), "SCORE_RUSH_CONFIG_PATH"))));
        var config = LoadConfig(configPath);

        var serverUrl = Arg(argsMap, "serverUrl", EnvOrDefault(config?.ServerUrl ?? "http://127.0.0.1:12348", "ETHERNAL_HUB_URL", "SCORE_RUSH_SERVER_URL"));
        var gameId = Arg(argsMap, "gameId", EnvOrDefault(config?.GameId ?? ScoreRushGame.GameId, "SCORE_RUSH_GAME_ID"));
        var serverKey = Arg(argsMap, "serverKey", EnvOrDefault(config?.ServerKey ?? "", "SCORE_RUSH_SERVER_KEY", "GAME_SERVER_KEY"));
        var serverId = Arg(argsMap, "serverId", EnvOrDefault(config?.ServerId ?? "score-rush-server-1", "SCORE_RUSH_SERVER_ID"));
        var region = Arg(argsMap, "region", EnvOrDefault(config?.Region ?? "eu", "SCORE_RUSH_REGION"));
        var capacity = ArgInt(argsMap, "capacity", IntOrDefault(config?.Capacity ?? 24, "SCORE_RUSH_CAPACITY"));

        if (string.IsNullOrWhiteSpace(serverKey))
        {
            var configHint = !string.IsNullOrWhiteSpace(configPath)
                ? $"\nThe config file at '{configPath}' was checked but did not contain a valid serverKey."
                : string.Empty;

            return ScoreRushStartupResult.Invalid(
                "Missing --serverKey and no SCORE_RUSH_SERVER_KEY environment variable is set." + configHint + "\n" +
                "Create a key for score-rush-2p via the hub admin API first:\n" +
                "  $token = \"admin-test\"\n" +
                "  Invoke-RestMethod -Method Post -Uri \"http://127.0.0.1:12348/admin/game-servers/score-rush-2p/keys\" -Headers @{ Authorization = \"Bearer $token\" }\n\n" +
                "Then set it and start the server:\n" +
                "  $env:SCORE_RUSH_SERVER_KEY='esk_...'\n" +
                "  $env:ETHERNAL_HUB_URL='http://127.0.0.1:12348'\n" +
                "  dotnet run --project csharp-sdk/EthernalCosmos.ScoreRush.Server -- --serverUrl $env:ETHERNAL_HUB_URL --serverKey $env:SCORE_RUSH_SERVER_KEY --serverId score-rush-srv-1 --region eu --capacity 24\n\nPress Enter to exit.");
        }

        return ScoreRushStartupResult.Valid(new GameServerClientOptions
        {
            ServerUrl = serverUrl,
            ServerKey = serverKey,
            GameId = gameId,
            ServerId = serverId,
            Region = region,
            Capacity = capacity,
            Version = "0.1.0",
        });
    }

    public static Dictionary<string, string> ParseArgs(string[] raw)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < raw.Length; i++)
        {
            var token = raw[i];
            if (!token.StartsWith("--", StringComparison.Ordinal)) continue;

            var key = token[2..];
            string value;
            var eq = key.IndexOf('=');
            if (eq >= 0)
            {
                value = key[(eq + 1)..];
                key = key[..eq];
            }
            else if (i + 1 < raw.Length && !raw[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                value = raw[++i];
            }
            else
            {
                value = "true";
            }

            map[key] = value;
        }

        return map;
    }

    private static string DefaultConfigFilePath()
    {
        return Path.Combine(Directory.GetCurrentDirectory(), DefaultConfigDirectory, DefaultConfigFileName);
    }

    private static ScoreRushServerConfig? LoadConfig(string? configPath)
    {
        if (string.IsNullOrWhiteSpace(configPath))
        {
            return null;
        }

        var path = configPath;
        if (!Path.IsPathRooted(path))
        {
            path = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), path));
        }

        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(path);
            var config = JsonSerializer.Deserialize<ScoreRushServerConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return config ?? new ScoreRushServerConfig();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"Unable to read startup config file '{path}': {ex.Message}", ex);
        }
    }

    private static string Arg(IReadOnlyDictionary<string, string> argsMap, string key, string fallback) =>
        argsMap.TryGetValue(key, out var value) ? value : fallback;

    private static int ArgInt(IReadOnlyDictionary<string, string> argsMap, string key, int fallback) =>
        argsMap.TryGetValue(key, out var value) && int.TryParse(value, out var parsed) ? parsed : fallback;

    private static string EnvOrDefault(string fallback, params string[] names)
    {
        foreach (var name in names)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return fallback;
    }

    private static int IntOrDefault(int fallback, params string[] names)
    {
        foreach (var name in names)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (int.TryParse(value, out var parsed))
            {
                return parsed;
            }
        }

        return fallback;
    }
}

internal sealed class ScoreRushServerConfig
{
    public string? ServerUrl { get; set; }
    public string? GameId { get; set; }
    public string? ServerKey { get; set; }
    public string? ServerId { get; set; }
    public string? Region { get; set; }
    public int? Capacity { get; set; }
}
