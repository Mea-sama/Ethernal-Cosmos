using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class AccountTests(HubFixture hub)
{
    [Fact]
    public async Task ChangePassword_stores_new_tokens_and_revokes_other_sessions()
    {
        await using var user = await hub.NewUserAsync();
        await using var other = new EthernalClient(new EthernalClientOptions { ServerUrl = hub.Url, ClientType = ClientType.Panel });
        await other.LoginAsync(user.Username, "password123");
        var otherReplaced = Wait.For<SessionReplacedData>(h => other.SessionReplaced += h, h => other.SessionReplaced -= h);
        var ownReplaced = false;
        user.Client.SessionReplaced += _ => ownReplaced = true;

        var wrong = await Assert.ThrowsAsync<EthernalException>(() => user.Client.ChangePasswordAsync("wrong-password", "newpassword1"));
        Assert.Equal(ErrorCode.InvalidCredentials, wrong.Error);
        var weak = await Assert.ThrowsAsync<EthernalException>(() => user.Client.ChangePasswordAsync("password123", "x"));
        Assert.Equal(ErrorCode.InvalidInput, weak.Error);

        var result = await user.Client.ChangePasswordAsync("password123", "newpassword1");
        Assert.Equal(user.UserId, result.User.UserId);
        Assert.NotEqual(user.Auth.RefreshToken, result.RefreshToken);

        // the client keeps working with its fresh tokens, the other session is gone
        Assert.Empty(await user.Client.GetBlockedUsersAsync());
        Assert.Empty(await user.Client.GetAllDataAsync("relay"));
        Assert.Equal(SessionReplacedReason.PasswordChanged, (await otherReplaced).Reason);
        Assert.False(ownReplaced);

        await using var oldPassword = hub.NewClient();
        var denied = await Assert.ThrowsAsync<EthernalException>(() => oldPassword.LoginAsync(user.Username, "password123"));
        Assert.Equal(ErrorCode.InvalidCredentials, denied.Error);
        await using var fresh = hub.NewClient();
        await fresh.LoginAsync(user.Username, "newpassword1");
    }

    [Fact]
    public async Task DeleteAccount_requires_the_password_and_frees_the_name()
    {
        var name = HubFixture.UniqueName("del");
        await using var client = hub.NewClient();
        await client.RegisterAsync(name, "password123");

        var wrong = await Assert.ThrowsAsync<EthernalException>(() => client.DeleteAccountAsync("nope-nope"));
        Assert.Equal(ErrorCode.InvalidCredentials, wrong.Error);
        await client.GetBlockedUsersAsync(); // still logged in after the failed attempt

        await client.DeleteAccountAsync("password123");
        await using var again = hub.NewClient();
        var login = await Assert.ThrowsAsync<EthernalException>(() => again.LoginAsync(name, "password123"));
        Assert.Equal(ErrorCode.InvalidCredentials, login.Error);
        await again.RegisterAsync(name, "password123");
    }

    [Fact]
    public async Task ExportAccountData_contains_the_own_data()
    {
        await using var user = await hub.NewUserAsync();
        await using var friend = await hub.NewUserAsync();
        await using var blocked = await hub.NewUserAsync();
        await user.Client.SetUserDataAsync("relay", "k", new { v = 1 });
        await user.Client.BlockUserAsync(blocked.UserId);
        var received = Wait.For<FriendRequestInfo>(h => friend.Client.FriendRequestReceived += h, h => friend.Client.FriendRequestReceived -= h);
        await user.Client.RequestFriendByNameAsync(friend.Username);
        await friend.Client.RespondFriendRequestAsync((await received).Id, accept: true);

        var export = await user.Client.ExportAccountDataAsync();
        Assert.True(export.ExportedAt > 0);
        Assert.Equal(user.UserId, export.Profile.Id);
        Assert.Equal(user.Username, export.Profile.Username);
        var entry = Assert.Single(export.UserData);
        Assert.Equal("relay", entry.GameId);
        Assert.Equal("k", entry.Key);
        Assert.Contains(export.Friends, f => f.UserId == friend.UserId);
        Assert.Contains(export.Blocks, b => b.UserId == blocked.UserId);
        Assert.NotNull(export.Settings);
    }
}

public class LimitTests
{
    [Fact]
    public async Task Rest_rate_limit_exposes_RetryAfterMs()
    {
        await using var limited = await HubProcess.StartAsync(limitOverrides: new() { ["restRateLimits"] = new { userdata = new { windowMs = 60000, max = 2 } } });
        await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = limited.Url });
        await client.RegisterAsync(HubFixture.UniqueName("rl"), "password123");

        await client.GetAllDataAsync("relay");
        await client.GetAllDataAsync("relay");
        var ex = await Assert.ThrowsAsync<EthernalException>(() => client.GetAllDataAsync("relay"));
        Assert.Equal(ErrorCode.RateLimited, ex.Error);
        Assert.True(ex.RetryAfterMs > 0);
    }

    [Fact]
    public async Task Socket_ack_and_connect_rate_limits_expose_RetryAfterMs()
    {
        await using var limited = await HubProcess.StartAsync(limitOverrides: new()
        {
            ["socketLimits"] = new Dictionary<string, object> { ["leaveLobby"] = new { refillPerSecond = 0.01, burst = 2 } },
            ["caps"] = new { maxSessionsPerUser = 1, capRetryAfterMs = 1234 },
        });
        var name = HubFixture.UniqueName("cap");
        await using var game = new EthernalClient(new EthernalClientOptions { ServerUrl = limited.Url });
        await game.RegisterAsync(name, "password123");

        await using var panel = new EthernalClient(new EthernalClientOptions { ServerUrl = limited.Url, ClientType = ClientType.Panel });
        var connect = await Assert.ThrowsAsync<EthernalException>(() => panel.LoginAsync(name, "password123"));
        Assert.Equal(ErrorCode.RateLimited, connect.Error);
        Assert.Equal(1234, connect.RetryAfterMs);

        await game.RegisterGameAsync("relay");
        await game.CreateLobbyAsync("l");
        await game.LeaveLobbyAsync();
        await game.CreateLobbyAsync("l");
        await game.LeaveLobbyAsync();
        var ack = await Assert.ThrowsAsync<EthernalException>(() => game.LeaveLobbyAsync());
        Assert.Equal(ErrorCode.RateLimited, ack.Error);
        Assert.True(ack.RetryAfterMs > 0);
    }

    [Fact]
    public async Task GameServer_connect_rate_limit_exposes_RetryAfterMs()
    {
        await using var limited = await HubProcess.StartAsync(limitOverrides: new() { ["caps"] = new { maxGameServersPerGame = 1, capRetryAfterMs = 4321 } });
        var key = await GameServerSupport.IssueKeyAsync(limited.Url, "gs-opt");
        await using var first = new GameServerClient(GameServerSupport.Options(limited.Url, key, "gs-opt"));
        await first.ConnectAsync();

        await using var second = new GameServerClient(GameServerSupport.Options(limited.Url, key, "gs-opt"));
        var ex = await Assert.ThrowsAsync<EthernalException>(() => second.ConnectAsync());
        Assert.Equal(ErrorCode.RateLimited, ex.Error);
        Assert.Equal(4321, ex.RetryAfterMs);
        Assert.NotNull(ex.ErrorData);
    }
}
