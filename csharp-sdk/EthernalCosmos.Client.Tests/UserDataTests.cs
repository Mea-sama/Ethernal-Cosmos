using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class UserDataTests(HubFixture hub)
{
    [Fact]
    public async Task Rest_set_get_bulk_delete()
    {
        await using var user = await hub.NewUserAsync();
        await user.Client.SetKeyAsync("relay", "level", 5, DataVisibility.Public);
        await user.Client.SetKeyAsync("relay", "note", new { text = "hello" });

        var all = await user.Client.GetAllDataAsync("relay");
        Assert.Equal(2, all.Length);
        var level = all.Single(e => e.Key == "level");
        Assert.Equal(DataVisibility.Public, level.Visibility);
        Assert.Equal(DataWriteScope.Client, level.WriteScope);
        Assert.Equal(5, ((JsonElement)level.Value!).GetInt32());
        Assert.Equal(DataVisibility.Private, all.Single(e => e.Key == "note").Visibility);

        await user.Client.BulkSetAsync("relay", [("a", 1, null), ("b", "two", DataVisibility.Lobby), ("c", true, DataVisibility.Public)]);
        var afterBulk = await user.Client.GetAllDataAsync("relay");
        Assert.Equal(5, afterBulk.Length);
        Assert.Equal(DataVisibility.Lobby, afterBulk.Single(e => e.Key == "b").Visibility);

        await user.Client.DeleteKeyAsync("relay", "a");
        Assert.DoesNotContain(await user.Client.GetAllDataAsync("relay"), e => e.Key == "a");
        await user.Client.DeleteKeyAsync("relay", "a"); // deleting is idempotent
    }

    [Fact]
    public async Task Rest_limits_report_typed_errors()
    {
        await using var user = await hub.NewUserAsync();
        var tooLarge = await Assert.ThrowsAsync<EthernalException>(() => user.Client.SetKeyAsync("relay", "big", new string('x', 20_000)));
        Assert.Equal(ErrorCode.DataValueTooLarge, tooLarge.Error);
    }

    [Fact]
    public async Task Socket_set_bulk_get_delete_and_events()
    {
        await using var user = await hub.NewUserAsync();
        await user.Client.SetUserDataAsync("relay", "a", new { x = 1 }, DataVisibility.Lobby);
        await user.Client.BulkSetUserDataAsync("relay", [("b", 2, null), ("c", 3, DataVisibility.Public)]);

        var evt = Wait.For<UserDataPayload>(h => user.Client.UserData += h, h => user.Client.UserData -= h);
        var entries = await user.Client.GetUserDataAsync("relay");
        Assert.Equal(["a", "b", "c"], entries.Select(e => e.Key).Order().ToArray());
        Assert.Equal(DataVisibility.Lobby, entries.Single(e => e.Key == "a").Visibility);
        var payload = await evt;
        Assert.Equal("relay", payload.GameId);
        Assert.Equal(3, payload.Entries.Length);

        await user.Client.DeleteUserDataAsync("relay", "b");
        Assert.DoesNotContain(await user.Client.GetUserDataAsync("relay"), e => e.Key == "b");
        await user.Client.DeleteUserDataAsync("relay", "b"); // idempotent
    }

    [Fact]
    public async Task GetPlayerDataAsync_respects_visibility()
    {
        await using var owner = await hub.NewUserAsync();
        await using var viewer = await hub.NewUserAsync();
        await owner.Client.BulkSetUserDataAsync("relay",
            [("pub", 1, DataVisibility.Public), ("lob", 2, DataVisibility.Lobby), ("priv", 3, DataVisibility.Private)]);

        var evt = Wait.For<PlayerDataPayload>(h => viewer.Client.PlayerData += h, h => viewer.Client.PlayerData -= h);
        var outside = await viewer.Client.GetPlayerDataAsync(owner.UserId, "relay");
        Assert.Equal(["pub"], outside.Select(e => e.Key).ToArray());
        var payload = await evt;
        Assert.Equal(owner.UserId, payload.PlayerId);
        Assert.Equal("relay", payload.GameId);

        var lobby = await owner.Client.CreateLobbyAsync("data");
        await viewer.Client.JoinLobbyAsync(lobby.Id);
        var together = await viewer.Client.GetPlayerDataAsync(owner.UserId, "relay");
        Assert.Equal(["lob", "pub"], together.Select(e => e.Key).Order().ToArray());
    }

    [Fact]
    public async Task GetLeaderboardAsync_orders_public_numeric_values()
    {
        var key = "score" + HubFixture.UniqueName();
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        await using var c = await hub.NewUserAsync();
        await a.Client.SetKeyAsync("relay", key, 10, DataVisibility.Public);
        await b.Client.SetKeyAsync("relay", key, 30, DataVisibility.Public);
        await c.Client.SetKeyAsync("relay", key, 20, DataVisibility.Public);

        var desc = await a.Client.GetLeaderboardAsync("relay", key);
        Assert.Equal([30, 20, 10], desc.Select(e => ((JsonElement)e.Value!).GetInt32()).ToArray());
        var asc = await a.Client.GetLeaderboardAsync("relay", key, order: "asc", limit: 2);
        Assert.Equal([10, 20], asc.Select(e => ((JsonElement)e.Value!).GetInt32()).ToArray());
    }

    [Fact]
    public async Task Rest_calls_refresh_the_access_token_when_it_expired()
    {
        await using var shortHub = await HubProcess.StartAsync(new() { ["ACCESS_TOKEN_TTL_SECONDS"] = "1" });
        await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = shortHub.Url });
        await client.RegisterAsync(HubFixture.UniqueName("rest"), "password123");
        await Task.Delay(2200);
        await client.SetKeyAsync("relay", "k", 1);
        Assert.Single(await client.GetAllDataAsync("relay"));
    }
}
