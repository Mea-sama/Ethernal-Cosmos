using EthernalCosmos.ScoreRush.Server;
using Xunit;

namespace EthernalCosmos.Client.Tests;

public class ScoreRushServerStartupTests
{
    [Fact]
    public void Missing_server_key_is_reported_and_keeps_console_visible()
    {
        var result = ScoreRushServerStartup.ValidateArgs(["--serverUrl", "http://127.0.0.1:12346"]);

        Assert.False(result.IsValid);
        Assert.Contains("--serverKey", result.Message);
        Assert.Contains("Press Enter to exit", result.Message);
    }

    [Fact]
    public void Valid_startup_arguments_are_accepted()
    {
        var result = ScoreRushServerStartup.ValidateArgs([
            "--serverUrl", "http://127.0.0.1:12346",
            "--serverKey", "esk_test_key",
            "--gameId", "score-rush-2p",
            "--serverId", "score-rush-srv-1",
            "--region", "eu",
            "--capacity", "12"
        ]);

        Assert.True(result.IsValid);
        Assert.Equal("score-rush-2p", result.Options?.GameId);
        Assert.Equal(12, result.Options?.Capacity);
    }

    [Fact]
    public void Environment_variables_can_supply_missing_startup_configuration()
    {
        var previousHub = Environment.GetEnvironmentVariable("ETHERNAL_HUB_URL");
        var previousKey = Environment.GetEnvironmentVariable("SCORE_RUSH_SERVER_KEY");

        try
        {
            Environment.SetEnvironmentVariable("ETHERNAL_HUB_URL", "http://127.0.0.1:12348");
            Environment.SetEnvironmentVariable("SCORE_RUSH_SERVER_KEY", "esk_env_key");

            var result = ScoreRushServerStartup.ValidateArgs([]);

            Assert.True(result.IsValid);
            Assert.Equal("esk_env_key", result.Options?.ServerKey);
            Assert.Equal("http://127.0.0.1:12348", result.Options?.ServerUrl);
        }
        finally
        {
            Environment.SetEnvironmentVariable("ETHERNAL_HUB_URL", previousHub);
            Environment.SetEnvironmentVariable("SCORE_RUSH_SERVER_KEY", previousKey);
        }
    }

    [Fact]
    public void Local_json_config_file_can_supply_missing_startup_configuration()
    {
        var previousCwd = Environment.CurrentDirectory;
        var tempDir = Path.Combine(Path.GetTempPath(), $"score-rush-config-{Guid.NewGuid():N}");

        try
        {
            Directory.CreateDirectory(Path.Combine(tempDir, ".secrets"));
            File.WriteAllText(
                Path.Combine(tempDir, ".secrets", "score-rush-server.json"),
                """
                {
                  "serverUrl": "https://mea-sama.duckdns.org:12346",
                  "gameId": "score-rush-2p",
                  "serverKey": "esk_file_key",
                  "serverId": "score-rush-srv-1",
                  "region": "eu",
                  "capacity": 16
                }
                """);

            Environment.CurrentDirectory = tempDir;

            var result = ScoreRushServerStartup.ValidateArgs([]);

            Assert.True(result.IsValid);
            Assert.Equal("esk_file_key", result.Options?.ServerKey);
            Assert.Equal("https://mea-sama.duckdns.org:12346", result.Options?.ServerUrl);
            Assert.Equal(16, result.Options?.Capacity);
        }
        finally
        {
            Environment.CurrentDirectory = previousCwd;
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }
}
