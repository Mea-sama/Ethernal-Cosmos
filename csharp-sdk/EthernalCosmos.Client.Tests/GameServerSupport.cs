using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace EthernalCosmos.Client.Tests;

/// <summary>Issues game server keys (admin API) and builds <see cref="GameServerClient"/> instances against a test hub.</summary>
public static class GameServerSupport
{
    public const string AdminToken = "admin-test";

    public static async Task<string> IssueKeyAsync(string hubUrl, string gameId)
    {
        using var http = new HttpClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{hubUrl}/admin/game-servers/{gameId}/keys")
        {
            Content = new StringContent("{\"label\":\"csharp-tests\"}", Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken);
        using var res = await http.SendAsync(req);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        return doc.RootElement.GetProperty("key").GetString()!;
    }

    public static GameServerClientOptions Options(string hubUrl, string key, string gameId, string? serverId = null, string? region = null, int capacity = 10) => new()
    {
        ServerUrl = hubUrl,
        ServerKey = key,
        GameId = gameId,
        ServerId = serverId ?? HubFixture.UniqueName("srv"),
        Region = region,
        Capacity = capacity,
        RequestTimeout = TimeSpan.FromSeconds(8),
    };

    /// <summary>Issues a key and connects a game server.</summary>
    public static async Task<GameServerClient> ConnectAsync(string hubUrl, string gameId, string? serverId = null, string? region = null, int capacity = 10)
    {
        var key = await IssueKeyAsync(hubUrl, gameId);
        var server = new GameServerClient(Options(hubUrl, key, gameId, serverId, region, capacity));
        await server.ConnectAsync();
        return server;
    }
}
