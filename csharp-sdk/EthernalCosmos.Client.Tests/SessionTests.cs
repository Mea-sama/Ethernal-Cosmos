using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class SessionTests(HubFixture hub)
{
    [Fact]
    public async Task RegisterGameAsync_returns_GameInfo_with_server_support_and_regions()
    {
        await using var user = await hub.NewUserAsync(game: null);

        var opt = await user.Client.RegisterGameAsync("gs-opt", clientVersion: "1.2.3", platform: "tests");
        Assert.Equal("gs-opt", opt.Game.Id);
        Assert.Equal(ServerSupport.Optional, opt.Game.ServerSupport);
        Assert.Equal(["eu", "us"], opt.Game.Regions!);
        Assert.Equal(user.UserId, opt.State.UserId);
        Assert.Equal("gs-opt", opt.State.GameId);

        var req = await user.Client.RegisterGameAsync("gs-req");
        Assert.Equal(ServerSupport.Required, req.Game.ServerSupport);

        var relay = await user.Client.RegisterGameAsync("relay");
        Assert.Equal(ServerSupport.None, relay.Game.ServerSupport);
        Assert.Equal(2, relay.Game.MaxPlayers);
        Assert.Equal(1500, relay.Game.ReconnectGraceMs);
        Assert.False(relay.Game.Hosted);

        var fake = await user.Client.RegisterGameAsync("echo");
        Assert.True(fake.Game.Hosted);
    }

    [Fact]
    public async Task RegisterGameAsync_unknown_game_throws_UnknownGame()
    {
        await using var user = await hub.NewUserAsync(game: null);
        var ex = await Assert.ThrowsAsync<EthernalException>(() => user.Client.RegisterGameAsync("no-such-game"));
        Assert.Equal(ErrorCode.UnknownGame, ex.Error);
    }

    [Fact]
    public async Task Lobby_calls_without_registered_game_throw_GameNotRegistered()
    {
        await using var user = await hub.NewUserAsync(game: null);
        var ex = await Assert.ThrowsAsync<EthernalException>(() => user.Client.CreateLobbyAsync("x"));
        Assert.Equal(ErrorCode.GameNotRegistered, ex.Error);
    }

    [Fact]
    public async Task GetSessionStateAsync_reports_game_and_lobby()
    {
        await using var user = await hub.NewUserAsync();
        var before = await user.Client.GetSessionStateAsync();
        Assert.Equal("relay", before.State.GameId);
        Assert.Null(before.Lobby);

        var lobby = await user.Client.CreateLobbyAsync("session-lobby");
        var after = await user.Client.GetSessionStateAsync();
        Assert.Equal(lobby.Id, after.State.LobbyId);
        Assert.Equal(lobby.Id, after.Lobby?.Id);
    }

    [Fact]
    public async Task Second_login_replaces_the_old_session_and_resumes_the_lobby()
    {
        await using var first = await hub.NewUserAsync();
        var lobby = await first.Client.CreateLobbyAsync("resume-lobby");
        var replaced = Wait.For<SessionReplacedData>(h => first.Client.SessionReplaced += h, h => first.Client.SessionReplaced -= h);

        await using var second = hub.NewClient();
        var hello = Wait.For<HelloPayload>(h => second.Hello += h, h => second.Hello -= h);
        var resumed = Wait.For<SessionResumedData>(h => second.SessionResumed += h, h => second.SessionResumed -= h);
        await second.LoginAsync(first.Username, "password123");

        Assert.Equal(SessionReplacedReason.NewSession, (await replaced).Reason);
        var helloPayload = await hello;
        Assert.Equal(lobby.Id, helloPayload.LobbyId);
        Assert.Equal("relay", helloPayload.GameId);
        var data = await resumed;
        Assert.Equal(lobby.Id, data.Lobby.Id);
        Assert.Equal(lobby.Id, data.State.LobbyId);

        // Membership stays with the user: the new session can use the lobby right away
        Assert.Equal(lobby.Id, (await second.GetLobbyInfoAsync()).Id);
    }

    [Fact]
    public async Task Game_registration_is_resent_on_a_new_connection_of_the_same_client()
    {
        // LoginAsync on an existing client replaces the socket; the registered game id is re-sent on connect
        await using var user = await hub.NewUserAsync();
        await user.Client.LoginAsync(user.Username, "password123");
        await Wait.Until(() => true, "noop");
        var state = await Wait.UntilResult(() => user.Client.GetSessionStateAsync(), s => s.State.GameId == "relay", "game re-registered");
        Assert.Equal("relay", state.State.GameId);
    }
}
