using System.Collections.Concurrent;
using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class GameServerTests(HubFixture hub)
{
    private const string Game = "gs-opt";

    private Task<GameServerClient> ServerAsync(string game = Game, string? serverId = null, string? region = null, int capacity = 10) =>
        GameServerSupport.ConnectAsync(hub.Url, game, serverId, region, capacity);

    private static int Int(object? value) => ((JsonElement)value!).GetInt32();

    [Fact]
    public async Task Connect_rejects_bad_keys_unknown_and_unsupported_games()
    {
        var key = await GameServerSupport.IssueKeyAsync(hub.Url, Game);

        async Task<EthernalException> Fail(string k, string game) =>
            await Assert.ThrowsAsync<EthernalException>(async () =>
            {
                await using var s = new GameServerClient(GameServerSupport.Options(hub.Url, k, game));
                await s.ConnectAsync();
            });

        Assert.Equal(ErrorCode.InvalidServerKey, (await Fail("esk_" + new string('x', 48), Game)).Error);
        Assert.Equal(ErrorCode.InvalidServerKey, (await Fail(key, "gs-req")).Error);
        Assert.Equal(ErrorCode.UnknownGame, (await Fail(key, "nope")).Error);
        Assert.Equal(ErrorCode.GameServerNotAllowed, (await Fail(key, "relay")).Error);

        await using var ok = new GameServerClient(GameServerSupport.Options(hub.Url, key, Game));
        var hello = await ok.ConnectAsync();
        Assert.True(ok.IsConnected);
        Assert.False(hello.Resumed);
        Assert.Equal(Game, hello.GameId);
    }

    [Fact]
    public async Task One_server_serves_two_lobbies_at_once_with_relay_state_and_actions()
    {
        await using var server = await ServerAsync(capacity: 5);
        var assigned = new ConcurrentBag<AssignInfo>();
        server.LobbyAssigned += assigned.Add;
        var actions = new ConcurrentQueue<PlayerAction>();
        server.PlayerAction += actions.Enqueue;
        var joined = new ConcurrentQueue<GameServerPlayerJoined>();
        server.PlayerJoined += joined.Enqueue;

        await using var host1 = await hub.NewUserAsync(Game);
        await using var guest1 = await hub.NewUserAsync(Game);
        await using var host2 = await hub.NewUserAsync(Game);

        var lobby1 = await host1.Client.CreateLobbyAsync("one");
        var lobby2 = await host2.Client.CreateLobbyAsync("two");
        await guest1.Client.JoinLobbyAsync(lobby1.Id);
        Assert.Equal(server.ServerId, lobby1.Server?.ServerId);
        Assert.Equal(server.ServerId, lobby2.Server?.ServerId);

        Assert.Contains(assigned, a => a.Lobby.Id == lobby1.Id && a.Reason == LobbyAssignReason.NewLobby && a.PreviousServerId is null);
        Assert.Contains(assigned, a => a.Lobby.Id == lobby2.Id && a.Reason == LobbyAssignReason.NewLobby);
        Assert.Contains(server.Lobbies, l => l.Id == lobby1.Id);
        Assert.Contains(server.Lobbies, l => l.Id == lobby2.Id);
        await Wait.Until(() => joined.Any(j => j.LobbyId == lobby1.Id && j.UserId == guest1.UserId), "player:joined for guest");

        // broadcast reaches only the members of that lobby
        var h1 = Wait.For<RelayMessage>(h => host1.Client.Message += h, h => host1.Client.Message -= h, m => m.Type == "round");
        var g1 = Wait.For<RelayMessage>(h => guest1.Client.Message += h, h => guest1.Client.Message -= h, m => m.Type == "round");
        var wrongLobby = new List<RelayMessage>();
        host2.Client.Message += wrongLobby.Add;
        var seq1 = await server.RelayToLobbyAsync(lobby1.Id, "round", new { n = 1 });
        var seq2 = await server.RelayToLobbyAsync(lobby1.Id, "round", new { n = 2 });
        Assert.True(seq2 > seq1);
        Assert.Equal(1, (await h1).PayloadAs<Dictionary<string, int>>()!["n"]);
        await g1;
        await Task.Delay(200);
        Assert.Empty(wrongLobby);

        // to a single player, plus the not-a-member error
        var only = Wait.For<RelayMessage>(h => guest1.Client.Message += h, h => guest1.Client.Message -= h, m => m.Type == "secret");
        await server.RelayToPlayerAsync(lobby1.Id, guest1.UserId, "secret", "psst");
        Assert.Equal("psst", (await only).PayloadAs<string>());
        var notMember = await Assert.ThrowsAsync<EthernalException>(() => server.RelayToPlayerAsync(lobby1.Id, host2.UserId, "secret"));
        Assert.Equal(ErrorCode.PlayerNotInLobby, notMember.Error);

        // state to one lobby
        var state = Wait.For<JsonElement>(h => host2.Client.GameState += h, h => host2.Client.GameState -= h);
        await server.SendStateAsync(lobby2.Id, new { board = "x" });
        Assert.Equal("x", (await state).GetProperty("board").GetString());
        var stateOne = Wait.For<JsonElement>(h => guest1.Client.GameState += h, h => guest1.Client.GameState -= h);
        await server.SendStateAsync(lobby1.Id, new { you = true }, guest1.UserId);
        Assert.True((await stateOne).GetProperty("you").GetBoolean());

        // player actions carry their lobby
        await host1.Client.SendGameActionAsync("move", new { to = "e4" });
        await host2.Client.SendGameActionAsync("move", new { to = "d4" });
        await Wait.Until(() => actions.Count >= 2, "two player actions");
        var a1 = actions.Single(a => a.LobbyId == lobby1.Id);
        var a2 = actions.Single(a => a.LobbyId == lobby2.Id);
        Assert.Equal(host1.UserId, a1.UserId);
        Assert.Equal("move", a1.Type);
        Assert.Equal("e4", a1.PayloadAs<Dictionary<string, string>>()!["to"]);
        Assert.Equal("d4", a2.PayloadAs<Dictionary<string, string>>()!["to"]);

        // lifecycle: settings, in_progress, game over closes one lobby only
        var updated = await server.SetLobbySettingsAsync(lobby1.Id, new() { ["mode"] = "blitz" });
        Assert.Equal("blitz", ((JsonElement)updated.Settings["mode"]!).GetString());
        Assert.Equal(LobbyStatus.InProgress, (await server.SetLobbyStateAsync(lobby1.Id, LobbyStatus.InProgress)).Status);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => server.SetLobbyStateAsync(lobby1.Id, LobbyStatus.Open));

        var over = Wait.For<JsonElement>(h => host1.Client.GameOver += h, h => host1.Client.GameOver -= h);
        var closed = Wait.For<GameServerLobbyClosed>(h => server.LobbyClosed += h, h => server.LobbyClosed -= h, c => c.LobbyId == lobby1.Id);
        await server.GameOverAsync(lobby1.Id, new { winner = host1.UserId });
        Assert.Equal(host1.UserId, (await over).GetProperty("winner").GetString());
        await closed;
        Assert.DoesNotContain(server.Lobbies, l => l.Id == lobby1.Id);
        Assert.Contains(server.Lobbies, l => l.Id == lobby2.Id);

        var closedTwo = Wait.For<GameServerLobbyClosed>(h => server.LobbyClosed += h, h => server.LobbyClosed -= h, c => c.LobbyId == lobby2.Id);
        await server.CloseLobbyAsync(lobby2.Id);
        await closedTwo;

        var gone = await Assert.ThrowsAsync<EthernalException>(() => server.RelayAsync("no-such-lobby", "x"));
        Assert.Equal(ErrorCode.NotLobbyServer, gone.Error);
    }

    [Fact]
    public async Task Player_events_and_kick_with_reason()
    {
        await using var server = await ServerAsync();
        await using var host = await hub.NewUserAsync(Game);
        await using var guest = await hub.NewUserAsync(Game);
        var lobby = await host.Client.CreateLobbyAsync("kick");

        var joined = Wait.For<GameServerPlayerJoined>(h => server.PlayerJoined += h, h => server.PlayerJoined -= h, j => j.LobbyId == lobby.Id);
        await guest.Client.JoinLobbyAsync(lobby.Id);
        Assert.Equal(guest.UserId, (await joined).UserId);
        Assert.Equal(guest.Username, (await joined).Username);

        var kicked = Wait.For<PlayerKickedData>(h => guest.Client.PlayerKicked += h, h => guest.Client.PlayerKicked -= h);
        var left = Wait.For<GameServerPlayerLeft>(h => server.PlayerLeft += h, h => server.PlayerLeft -= h, l => l.UserId == guest.UserId);
        await server.KickPlayerAsync(lobby.Id, guest.UserId, "cheating");
        var k = await kicked;
        Assert.Equal(lobby.Id, k.LobbyId);
        Assert.Equal("cheating", k.Reason);
        Assert.Equal(PlayerLeftReason.Kicked, (await left).Reason);
        Assert.DoesNotContain(server.Lobbies.Single(l => l.Id == lobby.Id).Players, p => p.UserId == guest.UserId);

        var banned = await Assert.ThrowsAsync<EthernalException>(() => guest.Client.JoinLobbyAsync(lobby.Id));
        Assert.Equal(ErrorCode.KickedFromLobby, banned.Error);
        await host.Client.UnkickPlayerAsync(guest.UserId);
        Assert.Equal(2, (await guest.Client.JoinLobbyAsync(lobby.Id)).Players.Length);

        // disconnected/reconnected presence
        var dropped = Wait.For<GameServerPlayerPresence>(h => server.PlayerDisconnected += h, h => server.PlayerDisconnected -= h, p => p.UserId == guest.UserId);
        await guest.Client.DisconnectAsync();
        Assert.Equal(lobby.Id, (await dropped).LobbyId);
        var back = Wait.For<GameServerPlayerPresence>(h => server.PlayerReconnected += h, h => server.PlayerReconnected -= h, p => p.UserId == guest.UserId);
        await guest.Client.LoginAsync(guest.Username, "password123");
        Assert.Equal(lobby.Id, (await back).LobbyId);
    }

    [Fact]
    public async Task Authoritative_data_writes_work_for_members_and_are_rejected_for_non_members()
    {
        await using var server = await ServerAsync();
        await using var member = await hub.NewUserAsync(Game);
        await using var outsider = await hub.NewUserAsync(Game);
        var lobby = await member.Client.CreateLobbyAsync("data");

        await server.SetDataAsync(lobby.Id, member.UserId, "gold", 5, DataVisibility.Private);
        await server.SetDataAsync(lobby.Id, member.UserId, "rank.points", 100, DataVisibility.Friends, DataWriteScope.Server);
        await server.BulkSetDataAsync(lobby.Id, member.UserId, [new("a", 1), new("b", "two", DataVisibility.Lobby)]);

        var entries = await server.GetDataAsync(lobby.Id, member.UserId);
        Assert.Equal(["a", "b", "gold", "rank.points"], entries.Select(e => e.Key).Order().ToArray());
        var gold = (await member.Client.GetUserDataAsync(Game)).Single(e => e.Key == "gold");
        Assert.Equal(5, Int(gold.Value));
        Assert.Equal(DataWriteScope.Server, entries.Single(e => e.Key == "rank.points").WriteScope);

        var inc = await server.IncrementDataAsync(lobby.Id, member.UserId, "gold", 7);
        Assert.Equal(12, Int(inc.Value));
        var setIf = await server.SetDataIfAsync(lobby.Id, member.UserId, "gold", 20, inc.Version);
        Assert.Equal(20, Int(setIf.Value));
        Assert.True(setIf.Version > inc.Version);
        var conflict = await Assert.ThrowsAsync<EthernalException>(() => server.SetDataIfAsync(lobby.Id, member.UserId, "gold", 1, inc.Version));
        Assert.Equal(ErrorCode.VersionConflict, conflict.Error);
        Assert.Equal(20, Int(conflict.Conflict!.Current!.Value));
        Assert.Equal(setIf.Version, conflict.Conflict.Current.Version);

        var results = await server.TransactDataAsync(lobby.Id, member.UserId,
            [UserDataOp.Increment("gold", 1), UserDataOp.Set("note", "hi"), UserDataOp.Delete("a")]);
        Assert.Equal(3, results.Length);
        Assert.Equal(21, Int(results[0].Value));
        await Assert.ThrowsAsync<EthernalException>(() => server.TransactDataAsync(lobby.Id, member.UserId,
            [UserDataOp.Increment("gold", 100), UserDataOp.SetIf("missing", 1, 9)]));
        Assert.Equal(21, Int((await server.GetDataAsync(lobby.Id, member.UserId)).Single(e => e.Key == "gold").Value));

        // not a member of the lobby -> NOT_ALLOWED, for every write flavour and for reads
        async Task AssertNotAllowed(Task t) => Assert.Equal(ErrorCode.NotAllowed, (await Assert.ThrowsAsync<EthernalException>(() => t)).Error);
        await AssertNotAllowed(server.SetDataAsync(lobby.Id, outsider.UserId, "gold", 1));
        await AssertNotAllowed(server.BulkSetDataAsync(lobby.Id, outsider.UserId, [new("x", 1)]));
        await AssertNotAllowed(server.GetDataAsync(lobby.Id, outsider.UserId));
        await AssertNotAllowed(server.IncrementDataAsync(lobby.Id, outsider.UserId, "gold", 1));
        await AssertNotAllowed(server.SetDataIfAsync(lobby.Id, outsider.UserId, "gold", 1, 0));
        await AssertNotAllowed(server.TransactDataAsync(lobby.Id, outsider.UserId, [UserDataOp.Set("x", 1)]));
        Assert.Empty(await outsider.Client.GetUserDataAsync(Game));

        // a lobby this server does not own
        var foreign = await Assert.ThrowsAsync<EthernalException>(() => server.SetDataAsync("no-such-lobby", member.UserId, "k", 1));
        Assert.True(foreign.Error is ErrorCode.NotAllowed or ErrorCode.NotLobbyServer);

        // clients still cannot touch server-written keys
        var write = await Assert.ThrowsAsync<EthernalException>(() => member.Client.SetUserDataAsync(Game, "rank.points", 1));
        Assert.Equal(ErrorCode.DataReadOnly, write.Error);
    }

    [Fact]
    public async Task Server_public_writes_feed_the_leaderboard_and_clients_cannot_write_public()
    {
        var key = "score" + HubFixture.UniqueName();
        await using var server = await ServerAsync();
        await using var u1 = await hub.NewUserAsync(Game);
        await using var u2 = await hub.NewUserAsync(Game);
        await using var u3 = await hub.NewUserAsync(Game);
        await using var outsider = await hub.NewUserAsync(Game);
        var lobby = await u1.Client.CreateLobbyAsync("board");
        await u2.Client.JoinLobbyAsync(lobby.Id);
        await u3.Client.JoinLobbyAsync(lobby.Id);
        await server.SetDataAsync(lobby.Id, u1.UserId, key, 10, DataVisibility.Public);
        await server.SetDataAsync(lobby.Id, u2.UserId, key, 30, DataVisibility.Public);
        await server.SetDataAsync(lobby.Id, u3.UserId, key, 20, DataVisibility.Public);

        var top = await u1.Client.GetLeaderboardAsync(Game, key);
        Assert.Equal([30, 20, 10], top.Select(e => Int(e.Value)).ToArray());
        Assert.Equal([1, 2, 3], top.Select(e => e.Rank).ToArray());
        Assert.Equal(u2.UserId, top[0].UserId);
        Assert.Equal(u2.Username, top[0].Username);

        var asc = await u1.Client.GetLeaderboardAsync(Game, key, order: "asc", limit: 2);
        Assert.Equal([10, 20], asc.Select(e => Int(e.Value)).ToArray());
        var paged = await u1.Client.GetLeaderboardAsync(Game, key, limit: 1, offset: 1);
        Assert.Equal(20, Int(Assert.Single(paged).Value));
        Assert.Equal(2, paged[0].Rank);

        var withMe = await u1.Client.GetLeaderboardWithMeAsync(Game, key, limit: 1);
        Assert.Equal(3, withMe.Total);
        Assert.Equal(u1.UserId, withMe.Me!.UserId);
        Assert.Equal(3, withMe.Me.Rank);
        Assert.Single(withMe.Entries);
        var around = await u3.Client.GetLeaderboardWithMeAsync(Game, key, around: true, range: 1);
        Assert.Equal([1, 2, 3], around.Entries.Select(e => e.Rank).ToArray());
        Assert.Equal(2, around.Me!.Rank);
        Assert.Null((await outsider.Client.GetLeaderboardWithMeAsync(Game, key)).Me);

        // friends scope: u1 and u3 are friends -> u2 disappears
        var received = Wait.For<FriendRequestInfo>(h => u3.Client.FriendRequestReceived += h, h => u3.Client.FriendRequestReceived -= h);
        await u1.Client.RequestFriendByNameAsync(u3.Username);
        await u3.Client.RespondFriendRequestAsync((await received).Id, accept: true);
        var friends = await u1.Client.GetLeaderboardAsync(Game, key, friendsOnly: true);
        Assert.Equal([u3.UserId, u1.UserId], friends.Select(e => e.UserId).ToArray());

        // leaderboardVisible hides a player from the board but not from `me`
        Assert.True((await u3.Client.GetSocialSettingsAsync()).LeaderboardVisible);
        Assert.False((await u3.Client.SetSocialSettingsAsync(leaderboardVisible: false)).LeaderboardVisible);
        Assert.DoesNotContain(await u1.Client.GetLeaderboardAsync(Game, key), e => e.UserId == u3.UserId);
        Assert.Equal(u3.UserId, (await u3.Client.GetLeaderboardWithMeAsync(Game, key)).Me!.UserId);

        // clients never write public values
        var socketWrite = await Assert.ThrowsAsync<EthernalException>(() => u1.Client.SetUserDataAsync(Game, "cheat", 1, DataVisibility.Public));
        Assert.Equal(ErrorCode.NotAllowed, socketWrite.Error);
        var restWrite = await Assert.ThrowsAsync<EthernalException>(() => u1.Client.SetKeyAsync(Game, "cheat", 1, DataVisibility.Public));
        Assert.Equal(ErrorCode.NotAllowed, restWrite.Error);
        var noBoard = await Assert.ThrowsAsync<EthernalException>(() => u1.Client.GetLeaderboardAsync("relay", key));
        Assert.Equal(ErrorCode.NotFound, noBoard.Error);
    }

    [Fact]
    public async Task Rejecting_servers_are_skipped_and_the_handler_can_inspect_the_assignment()
    {
        await using var rejecting = await ServerAsync();
        var seen = new ConcurrentQueue<AssignInfo>();
        rejecting.AssignmentHandler = info => { seen.Enqueue(info); return Task.FromResult(AssignmentDecision.Reject("full")); };
        await using var accepting = await ServerAsync();

        await using var host = await hub.NewUserAsync(Game);
        var lobby = await host.Client.CreateLobbyAsync("picky");
        Assert.Equal(accepting.ServerId, lobby.Server?.ServerId);
        Assert.DoesNotContain(rejecting.Lobbies, l => l.Id == lobby.Id);
        Assert.All(seen, a => Assert.Equal(LobbyAssignReason.NewLobby, a.Reason));
    }

    [Fact]
    public async Task Status_heartbeat_and_drain_keep_lobbies_but_stop_new_assignments()
    {
        await using var draining = await ServerAsync(region: "eu", capacity: 5);
        await using var other = await ServerAsync(region: "us");
        await using var host = await hub.NewUserAsync(Game);
        var lobby = await host.Client.CreateLobbyAsync("old", serverRegion: "eu");
        Assert.Equal(draining.ServerId, lobby.Server?.ServerId);

        var info = await draining.ReportStatusAsync();
        Assert.False(info.Draining);
        Assert.True(info.Load >= 1);
        Assert.Equal(5, info.Capacity);
        Assert.Equal(8, (await draining.ReportStatusAsync(capacity: 8)).Capacity);

        var changed = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.ServerDraining);
        Assert.True((await draining.DrainAsync()).Draining);
        Assert.Equal(LobbyServerStatus.Draining, (await changed).Item1.ServerStatus);

        await using var next = await hub.NewUserAsync(Game);
        var fresh = await next.Client.CreateLobbyAsync("new", serverRegion: "eu");
        Assert.Equal(other.ServerId, fresh.Server?.ServerId);
        Assert.Contains(draining.Lobbies, l => l.Id == lobby.Id);
        await draining.RelayToLobbyAsync(lobby.Id, "still-running");

        Assert.False((await draining.DrainAsync(false)).Draining);
    }

    [Fact]
    public async Task Disconnected_server_resumes_within_the_grace_period()
    {
        var serverId = HubFixture.UniqueName("resume");
        var key = await GameServerSupport.IssueKeyAsync(hub.Url, Game);
        await using var server = new GameServerClient(GameServerSupport.Options(hub.Url, key, Game, serverId));
        await server.ConnectAsync();
        await using var host = await hub.NewUserAsync(Game);
        var lobby = await host.Client.CreateLobbyAsync("resume");

        var lost = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.ServerLost);
        var disconnected = Wait.For<string>(h => server.Disconnected += h, h => server.Disconnected -= h);
        await server.DisconnectAsync();
        await disconnected;
        Assert.False(server.IsConnected);
        Assert.Equal(LobbyServerStatus.Lost, (await lost).Item1.ServerStatus);

        var resumedEvent = Wait.For<GameServerHello>(h => server.Hello += h, h => server.Hello -= h);
        var hello = await server.ConnectAsync();
        Assert.True(hello.Resumed);
        Assert.Contains(hello.Lobbies, l => l.Id == lobby.Id);
        Assert.True((await resumedEvent).Resumed);
        Assert.Contains(server.Lobbies, l => l.Id == lobby.Id);
        await server.RelayToLobbyAsync(lobby.Id, "after-resume");
    }

    [Fact]
    public async Task Lost_server_is_replaced_by_a_second_server_with_ServerRebound()
    {
        var serverA = await ServerAsync(region: "eu");
        await using var serverB = await ServerAsync(region: "us");
        var rebounds = new ConcurrentQueue<AssignInfo>();
        serverB.LobbyAssigned += rebounds.Enqueue;

        await using var host = await hub.NewUserAsync(Game);
        var lobby = await host.Client.CreateLobbyAsync("rebind", serverRegion: "eu");
        Assert.Equal(serverA.ServerId, lobby.Server?.ServerId);
        var statusUpdates = new ConcurrentQueue<LobbyChangeReason?>();
        host.Client.LobbyChanged += (_, r) => statusUpdates.Enqueue(r);

        var lostAtLeast = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await serverA.DisposeAsync();

        var assignment = await Wait.UntilResult(() => Task.FromResult(rebounds.FirstOrDefault(a => a.Lobby.Id == lobby.Id)), a => a is not null, "rebound assignment", TimeSpan.FromSeconds(10));
        Assert.Equal(LobbyAssignReason.ServerRebound, assignment!.Reason);
        Assert.Equal(serverA.ServerId, assignment.PreviousServerId);
        Assert.True(assignment.LostAt >= lostAtLeast - 2000);
        Assert.Contains(assignment.Players, p => p.UserId == host.UserId);
        Assert.Contains(serverB.Lobbies, l => l.Id == lobby.Id);

        await Wait.Until(() => statusUpdates.Contains(LobbyChangeReason.ServerRebound), "players see server_rebound");
        Assert.Contains(LobbyChangeReason.ServerLost, statusUpdates);
        var info = await host.Client.GetLobbyInfoAsync();
        Assert.Equal(serverB.ServerId, info.Server?.ServerId);
        Assert.Equal(LobbyServerStatus.Ok, info.ServerStatus);

        var message = Wait.For<RelayMessage>(h => host.Client.Message += h, h => host.Client.Message -= h, m => m.Type == "welcome-back");
        await serverB.RelayToLobbyAsync(lobby.Id, "welcome-back");
        await message;
    }
}
