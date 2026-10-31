using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class GameTests(HubFixture hub)
{
    [Fact]
    public async Task Hosted_game_lobby_emits_GameStarting_and_routes_actions_to_events()
    {
        await using var host = await hub.NewUserAsync("echo");
        var starting = Wait.For<GameStartingData>(h => host.Client.GameStarting += h, h => host.Client.GameStarting -= h);
        var lobby = await host.Client.CreateLobbyAsync("echo-lobby");
        var started = await starting;
        Assert.Equal(lobby.Id, started.LobbyId);
        Assert.Equal("echo", started.GameId);
        Assert.True(lobby.Hosted);

        var gameEvent = Wait.For<JsonElement>(h => host.Client.GameEvent += h, h => host.Client.GameEvent -= h);
        await host.Client.SendGameActionAsync("event", new { n = 5 });
        var ev = await gameEvent;
        Assert.Equal(host.UserId, ev.GetProperty("from").GetString());
        Assert.Equal(5, ev.GetProperty("data").GetProperty("n").GetInt32());

        var state = Wait.For<JsonElement>(h => host.Client.GameState += h, h => host.Client.GameState -= h);
        await host.Client.SendGameActionAsync("state", 2);
        Assert.Equal(2, (await state).GetProperty("round").GetInt32());

        var forMe = Wait.For<JsonElement>(h => host.Client.GameState += h, h => host.Client.GameState -= h, e => e.TryGetProperty("secret", out _));
        await host.Client.SendGameActionAsync("stateForMe", "s3cret");
        Assert.Equal("s3cret", (await forMe).GetProperty("secret").GetString());

        var over = Wait.For<JsonElement>(h => host.Client.GameOver += h, h => host.Client.GameOver -= h);
        var closed = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item1.Status == LobbyStatus.Closed);
        await host.Client.SendGameActionAsync("over");
        Assert.Equal(host.UserId, (await over).GetProperty("winner").GetString());
        Assert.Equal(LobbyStatus.Closed, (await closed).Item1.Status);
    }

    [Fact]
    public async Task Game_action_without_running_game_throws_GameNotRunning()
    {
        await using var host = await hub.NewUserAsync("relay");
        await host.Client.CreateLobbyAsync("no-process");
        var ex = await Assert.ThrowsAsync<EthernalException>(() => host.Client.SendGameActionAsync("x"));
        Assert.Equal(ErrorCode.GameNotRunning, ex.Error);
    }

    [Fact]
    public async Task Server_written_keys_are_read_only_for_clients()
    {
        await using var host = await hub.NewUserAsync("echo");
        await host.Client.CreateLobbyAsync("saves");
        await host.Client.SendGameActionAsync("save", 42);

        var entries = await Wait.UntilResult(() => host.Client.GetUserDataAsync("echo"), e => e.Length > 0, "SAVE_META written");
        var entry = Assert.Single(entries);
        Assert.Equal("rank.points", entry.Key);
        Assert.Equal(DataWriteScope.Server, entry.WriteScope);
        Assert.Equal(DataVisibility.Public, entry.Visibility);

        var socketWrite = await Assert.ThrowsAsync<EthernalException>(() => host.Client.SetUserDataAsync("echo", "rank.points", 1));
        Assert.Equal(ErrorCode.DataReadOnly, socketWrite.Error);
        var restWrite = await Assert.ThrowsAsync<EthernalException>(() => host.Client.SetKeyAsync("echo", "rank.points", 1));
        Assert.Equal(ErrorCode.DataReadOnly, restWrite.Error);
        var restDelete = await Assert.ThrowsAsync<EthernalException>(() => host.Client.DeleteKeyAsync("echo", "rank.points"));
        Assert.Equal(ErrorCode.DataReadOnly, restDelete.Error);
        var socketDelete = await Assert.ThrowsAsync<EthernalException>(() => host.Client.DeleteUserDataAsync("echo", "rank.points"));
        Assert.Equal(ErrorCode.DataReadOnly, socketDelete.Error);
    }
}
