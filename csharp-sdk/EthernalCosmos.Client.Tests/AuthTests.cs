using System.Net.Http.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class AuthTests(HubFixture hub)
{
    [Fact]
    public async Task RegisterAsync_returns_tokens_and_connects_the_socket()
    {
        var client = hub.NewClient();
        var name = HubFixture.UniqueName("reg");
        var hello = Wait.For<HelloPayload>(h => client.Hello += h, h => client.Hello -= h);
        var connected = Wait.ForSignal(h => client.Connected += h, h => client.Connected -= h);

        var auth = await client.RegisterAsync(name, "password123");

        Assert.Equal(name, auth.User.Username);
        Assert.False(string.IsNullOrEmpty(auth.User.UserId));
        Assert.False(string.IsNullOrEmpty(auth.AccessToken));
        Assert.False(string.IsNullOrEmpty(auth.RefreshToken));
        await connected;
        var payload = await hello;
        Assert.True(payload.ProtocolVersion >= 1);
        Assert.Contains("social", payload.Capabilities);
        Assert.False(string.IsNullOrEmpty(payload.SessionId));
        Assert.Null(payload.LobbyId);
        await client.DisposeAsync();
    }

    [Fact]
    public async Task LoginAsync_with_valid_credentials_works_and_case_insensitive()
    {
        var name = HubFixture.UniqueName("Login");
        await using (var first = hub.NewClient()) await first.RegisterAsync(name, "password123");

        await using var client = hub.NewClient();
        var auth = await client.LoginAsync(name.ToUpperInvariant(), "password123");
        Assert.Equal(name, auth.User.Username);
        var state = await client.GetSessionStateAsync();
        Assert.Equal(name, state.State.Username);
    }

    [Fact]
    public async Task Wrong_password_throws_EthernalException_with_typed_code()
    {
        var name = HubFixture.UniqueName("bad");
        await using (var first = hub.NewClient()) await first.RegisterAsync(name, "password123");

        await using var client = hub.NewClient();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => client.LoginAsync(name, "wrong-password"));
        Assert.Equal(ErrorCode.InvalidCredentials, ex.Error);
        Assert.Equal("INVALID_CREDENTIALS", ex.Code);
    }

    [Fact]
    public async Task Duplicate_username_throws_UsernameTaken()
    {
        var name = HubFixture.UniqueName("dup");
        await using (var first = hub.NewClient()) await first.RegisterAsync(name, "password123");

        await using var client = hub.NewClient();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => client.RegisterAsync(name.ToLowerInvariant(), "password123"));
        Assert.Equal(ErrorCode.UsernameTaken, ex.Error);
    }

    [Fact]
    public async Task Invalid_input_is_reported_as_InvalidInput()
    {
        await using var client = hub.NewClient();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => client.RegisterAsync("x", "1"));
        Assert.Equal(ErrorCode.InvalidInput, ex.Error);
    }

    [Fact]
    public async Task Calls_without_login_throw_InvalidOperationException()
    {
        await using var client = hub.NewClient();
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.ListLobbiesAsync());
    }

    [Fact]
    public async Task LogoutAsync_disconnects_and_revokes_refresh_token()
    {
        var user = await hub.NewUserAsync(game: null, prefix: "lo");

        await user.Client.LogoutAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(() => user.Client.ListLobbiesAsync());
        // The old refresh token is dead: log in anew with a client that tries to refresh via REST
        using var http = new HttpClient();
        var res = await http.PostAsJsonAsync(hub.Url + "/auth/refresh", new { refreshToken = user.Auth.RefreshToken });
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, res.StatusCode);
        await user.DisposeAsync();
    }

    [Fact]
    public async Task LogoutAllAsync_revokes_all_refresh_tokens_and_disconnects()
    {
        await using var user = await hub.NewUserAsync(game: null, prefix: "la");
        var oldRefresh = user.Auth.RefreshToken;

        await user.Client.LogoutAllAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(() => user.Client.ListLobbiesAsync());
        using var http = new HttpClient();
        var res = await http.PostAsJsonAsync(hub.Url + "/auth/refresh", new { refreshToken = oldRefresh });
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, res.StatusCode);

        await using var again = hub.NewClient();
        await again.LoginAsync(user.Username, "password123"); // credentials still work, only tokens were revoked
    }

    [Fact]
    public async Task RefreshSocketAuthAsync_keeps_the_socket_authenticated()
    {
        await using var user = await hub.NewUserAsync(game: null, prefix: "rf");
        await user.Client.RefreshSocketAuthAsync();
        var state = await user.Client.GetSessionStateAsync();
        Assert.Equal(user.UserId, state.State.UserId);
    }

    [Fact]
    public async Task AUTH_EXPIRED_triggers_automatic_refresh_and_keeps_the_session()
    {
        await using var shortHub = await HubProcess.StartAsync(new() { ["ACCESS_TOKEN_TTL_SECONDS"] = "2", ["AUTH_EXPIRY_GRACE_MS"] = "3000" });
        await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = shortHub.Url });
        var expired = Wait.For<HubErrorPayload>(h => client.ErrorDetail += h, h => client.ErrorDetail -= h, d => d.Error == ErrorCode.AuthExpired);
        var authErrors = new List<string>();
        client.AuthError += authErrors.Add;
        await client.RegisterAsync(HubFixture.UniqueName("ae"), "password123");

        var detail = await expired;
        Assert.Equal("AUTH_EXPIRED", detail.Code);

        // The SDK refreshes in the background; the socket must survive past expiry + grace
        await Task.Delay(4500);
        var state = await client.GetSessionStateAsync();
        Assert.False(string.IsNullOrEmpty(state.State.UserId));
        Assert.Empty(authErrors);
    }

    [Fact]
    public async Task Disconnected_is_raised_when_the_hub_goes_away()
    {
        var h = await HubProcess.StartAsync();
        await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = h.Url });
        await client.RegisterAsync(HubFixture.UniqueName("dc"), "password123");
        var serverErrors = new List<string>();
        client.ServerError += serverErrors.Add;
        var disconnected = Wait.For<string>(x => client.Disconnected += x, x => client.Disconnected -= x, timeout: TimeSpan.FromSeconds(20));
        await h.DisposeAsync();
        Assert.False(string.IsNullOrEmpty(await disconnected));
    }

    [Fact]
    public async Task Disconnected_is_raised_exactly_once_after_a_local_DisconnectAsync_and_login_resumes()
    {
        var h = await HubProcess.StartAsync();
        await using var _h = h;
        var name = HubFixture.UniqueName("ld");
        for (var i = 0; i < 5; i++)
        {
            await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = h.Url });
            if (i == 0) await client.RegisterAsync(name, "password123"); else await client.LoginAsync(name, "password123");
            var reasons = new List<string>();
            client.Disconnected += reasons.Add;
            var disconnected = Wait.For<string>(x => client.Disconnected += x, x => client.Disconnected -= x, timeout: TimeSpan.FromSeconds(5));
            await client.DisconnectAsync();
            Assert.False(string.IsNullOrEmpty(await disconnected));
            await Task.Delay(150);
            Assert.Single(reasons);
            await Assert.ThrowsAsync<InvalidOperationException>(() => client.GetSessionStateAsync());
        }

        await using var again = new EthernalClient(new EthernalClientOptions { ServerUrl = h.Url });
        await again.LoginAsync(name, "password123");
        Assert.False(string.IsNullOrEmpty((await again.GetSessionStateAsync()).State.UserId));
    }
}
