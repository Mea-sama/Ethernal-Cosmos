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
        await user.Client.SetKeyAsync("relay", "level", 5, DataVisibility.Friends);
        await user.Client.SetKeyAsync("relay", "note", new { text = "hello" });

        var all = await user.Client.GetAllDataAsync("relay");
        Assert.Equal(2, all.Length);
        var level = all.Single(e => e.Key == "level");
        Assert.Equal(DataVisibility.Friends, level.Visibility);
        Assert.Equal(DataWriteScope.Client, level.WriteScope);
        Assert.Equal(5, ((JsonElement)level.Value!).GetInt32());
        Assert.Equal(DataVisibility.Private, all.Single(e => e.Key == "note").Visibility);

        await user.Client.BulkSetAsync("relay", [("a", 1, null), ("b", "two", DataVisibility.Lobby), ("c", true, DataVisibility.Friends)]);
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
        await user.Client.BulkSetUserDataAsync("relay", [("b", 2, null), ("c", 3, DataVisibility.Friends)]);

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
    public async Task GetPlayerDataAsync_respects_relations_and_visibility()
    {
        await using var owner = await hub.NewUserAsync();
        await using var mate = await hub.NewUserAsync();
        await using var stranger = await hub.NewUserAsync();
        await owner.Client.BulkSetUserDataAsync("relay",
            [("fr", 1, DataVisibility.Friends), ("lob", 2, DataVisibility.Lobby), ("priv", 3, DataVisibility.Private)]);

        var denied = await Assert.ThrowsAsync<EthernalException>(() => stranger.Client.GetPlayerDataAsync(owner.UserId, "relay"));
        Assert.Equal(ErrorCode.NotAllowed, denied.Error);

        var lobby = await owner.Client.CreateLobbyAsync("data");
        await mate.Client.JoinLobbyAsync(lobby.Id);
        var evt = Wait.For<PlayerDataPayload>(h => mate.Client.PlayerData += h, h => mate.Client.PlayerData -= h);
        var together = await mate.Client.GetPlayerDataAsync(owner.UserId, "relay");
        Assert.Equal(["lob"], together.Select(e => e.Key).ToArray());
        var payload = await evt;
        Assert.Equal(owner.UserId, payload.PlayerId);
        Assert.Equal("relay", payload.GameId);

        var received = Wait.For<FriendRequestInfo>(h => owner.Client.FriendRequestReceived += h, h => owner.Client.FriendRequestReceived -= h);
        await stranger.Client.RequestFriendByNameAsync(owner.Username);
        await owner.Client.RespondFriendRequestAsync((await received).Id, accept: true);
        var friend = await stranger.Client.GetPlayerDataAsync(owner.UserId, "relay");
        Assert.Equal(["fr"], friend.Select(e => e.Key).ToArray());
    }

    [Fact]
    public async Task Increment_setIf_and_transact_are_atomic_over_the_socket()
    {
        await using var user = await hub.NewUserAsync();
        var first = await user.Client.IncrementUserDataAsync("relay", "xp", 5);
        Assert.Equal(5, ((JsonElement)first.Value!).GetInt32());
        var second = await user.Client.IncrementUserDataAsync("relay", "xp", 2.5, DataVisibility.Friends);
        Assert.Equal(7.5, ((JsonElement)second.Value!).GetDouble());
        Assert.True(second.Version > first.Version);

        var created = await user.Client.SetUserDataIfAsync("relay", "slot", "a", 0);
        var swapped = await user.Client.SetUserDataIfAsync("relay", "slot", "b", created.Version);
        Assert.True(swapped.Version > created.Version);
        var conflict = await Assert.ThrowsAsync<EthernalException>(() => user.Client.SetUserDataIfAsync("relay", "slot", "c", created.Version));
        Assert.Equal(ErrorCode.VersionConflict, conflict.Error);
        Assert.Equal("b", ((JsonElement)conflict.Conflict!.Current!.Value!).GetString());
        Assert.Equal(swapped.Version, conflict.Conflict.Current.Version);

        var results = await user.Client.TransactUserDataAsync("relay", [UserDataOp.Increment("xp", 1), UserDataOp.Set("name", "n"), UserDataOp.Delete("slot")]);
        Assert.Equal(3, results.Length);
        Assert.Equal(8.5, ((JsonElement)results[0].Value!).GetDouble());

        var failed = await Assert.ThrowsAsync<EthernalException>(() =>
            user.Client.TransactUserDataAsync("relay", [UserDataOp.Increment("xp", 100), UserDataOp.SetIf("name", "z", 99)]));
        Assert.Equal(ErrorCode.VersionConflict, failed.Error);
        var xp = (await user.Client.GetUserDataAsync("relay")).Single(e => e.Key == "xp");
        Assert.Equal(8.5, ((JsonElement)xp.Value!).GetDouble());
    }

    [Fact]
    public async Task Client_public_writes_are_not_allowed()
    {
        await using var user = await hub.NewUserAsync();
        Assert.Equal(ErrorCode.NotAllowed, (await Assert.ThrowsAsync<EthernalException>(() => user.Client.SetUserDataAsync("relay", "p", 1, DataVisibility.Public))).Error);
        Assert.Equal(ErrorCode.NotAllowed, (await Assert.ThrowsAsync<EthernalException>(() => user.Client.SetKeyAsync("relay", "p", 1, DataVisibility.Public))).Error);
        Assert.Equal(ErrorCode.NotAllowed, (await Assert.ThrowsAsync<EthernalException>(() => user.Client.IncrementUserDataAsync("relay", "p", 1, DataVisibility.Public))).Error);
        Assert.Empty(await user.Client.GetUserDataAsync("relay"));
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
