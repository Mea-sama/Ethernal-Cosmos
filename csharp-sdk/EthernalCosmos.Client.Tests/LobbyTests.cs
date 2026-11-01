using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class LobbyTests(HubFixture hub)
{
    [Fact]
    public async Task Create_list_info_join_leave_with_events()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();

        var created = Wait.For<Lobby>(h => host.Client.LobbyCreated += h, h => host.Client.LobbyCreated -= h);
        var settings = new Dictionary<string, object?> { ["mode"] = "ffa", ["rounds"] = 3 };
        var lobby = await host.Client.CreateLobbyAsync("Fast game", settings: settings);
        Assert.Equal("Fast game", lobby.Name);
        Assert.Equal("relay", lobby.GameId);
        Assert.Equal(host.UserId, lobby.HostId);
        Assert.Equal(2, lobby.MaxPlayers);
        Assert.Equal(LobbyStatus.Open, lobby.Status);
        Assert.False(lobby.Locked);
        Assert.False(lobby.IsPrivate);
        Assert.Single(lobby.Players);
        Assert.True(lobby.Players[0].IsHost);
        Assert.True(lobby.Players[0].Connected);
        Assert.Equal("ffa", lobby.Settings["mode"]?.ToString());
        Assert.Equal(lobby.Id, (await created).Id);

        var listEvent = Wait.For<Lobby[]>(h => guest.Client.LobbyList += h, h => guest.Client.LobbyList -= h);
        var list = await guest.Client.ListLobbiesAsync();
        Assert.Contains(list, l => l.Id == lobby.Id);
        Assert.Contains((await listEvent), l => l.Id == lobby.Id);

        var infoEvent = Wait.For<Lobby>(h => host.Client.LobbyInfo += h, h => host.Client.LobbyInfo -= h);
        Assert.Equal(lobby.Id, (await host.Client.GetLobbyInfoAsync()).Id);
        Assert.Equal(lobby.Id, (await infoEvent).Id);

        var hostUpdated = Wait.For<Lobby>(h => host.Client.LobbyUpdated += h, h => host.Client.LobbyUpdated -= h);
        var hostChanged = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.PlayerJoined);
        var joined = await guest.Client.JoinLobbyAsync(lobby.Id);
        Assert.Equal(2, joined.Players.Length);
        Assert.Equal(LobbyStatus.Full, joined.Status);
        Assert.Equal(2, (await hostUpdated).Players.Length);
        Assert.Equal(LobbyChangeReason.PlayerJoined, (await hostChanged).Item2);

        var left = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.PlayerLeft);
        await guest.Client.LeaveLobbyAsync();
        var (afterLeave, reason) = await left;
        Assert.Equal(LobbyChangeReason.PlayerLeft, reason);
        Assert.Single(afterLeave.Players);
        Assert.Null((await guest.Client.GetSessionStateAsync()).Lobby);
    }

    [Fact]
    public async Task Private_lobby_is_joined_by_code_and_hidden_from_listing()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();

        var lobby = await host.Client.CreateLobbyAsync("secret", isPrivate: true);
        Assert.True(lobby.IsPrivate);
        Assert.Equal(6, lobby.InviteCode?.Length);
        Assert.DoesNotContain(await guest.Client.ListLobbiesAsync(), l => l.Id == lobby.Id);

        var idJoin = await Assert.ThrowsAsync<EthernalException>(() => guest.Client.JoinLobbyAsync(lobby.Id));
        Assert.Equal(ErrorCode.LobbyPrivate, idJoin.Error);

        var joined = await guest.Client.JoinLobbyByCodeAsync(lobby.InviteCode!);
        Assert.Equal(lobby.Id, joined.Id);

        await using var other = await hub.NewUserAsync();
        Assert.Equal(ErrorCode.InviteCodeNotFound, (await Assert.ThrowsAsync<EthernalException>(() => other.Client.JoinLobbyByCodeAsync("ZZZZZZ"))).Error);
        Assert.Equal(ErrorCode.InvalidInviteCode, (await Assert.ThrowsAsync<EthernalException>(() => other.Client.JoinLobbyByCodeAsync("abc"))).Error);
    }

    [Fact]
    public async Task Lobby_full_and_wrong_game_errors()
    {
        await using var host = await hub.NewUserAsync();
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        await using var otherGame = await hub.NewUserAsync("other");

        var lobby = await host.Client.CreateLobbyAsync("full");
        await a.Client.JoinLobbyAsync(lobby.Id);
        Assert.Equal(ErrorCode.LobbyFull, (await Assert.ThrowsAsync<EthernalException>(() => b.Client.JoinLobbyAsync(lobby.Id))).Error);
        Assert.Equal(ErrorCode.GameMismatch, (await Assert.ThrowsAsync<EthernalException>(() => otherGame.Client.JoinLobbyAsync(lobby.Id))).Error);
        Assert.Equal(ErrorCode.AlreadyInLobby, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.CreateLobbyAsync("again"))).Error);
        Assert.Equal(ErrorCode.LobbyNotFound, (await Assert.ThrowsAsync<EthernalException>(() => b.Client.JoinLobbyAsync("nope"))).Error);
    }

    [Fact]
    public async Task Server_preference_arguments_are_validated_by_the_hub()
    {
        await using var user = await hub.NewUserAsync("gs-opt");

        // Optional game server support: no server connected -> lobby is created without one
        var anyServer = await user.Client.CreateLobbyAsync("any", serverMode: ServerMode.Any, serverRegion: "eu");
        Assert.Null(anyServer.Server);
        await user.Client.LeaveLobbyAsync();

        var none = await user.Client.CreateLobbyAsync("none", serverMode: ServerMode.None);
        Assert.Null(none.Server);
        await user.Client.LeaveLobbyAsync();

        // Required game server support without any server -> cannot create
        await user.Client.RegisterGameAsync("gs-req");
        var required = await Assert.ThrowsAsync<EthernalException>(() => user.Client.CreateLobbyAsync("req", serverRegion: "us"));
        Assert.Equal(ErrorCode.NoGameServerAvailable, required.Error);
    }

    [Fact]
    public async Task Lock_blocks_direct_joins_and_unlock_reopens()
    {
        await using var host = await hub.NewUserAsync("other");
        await using var guest = await hub.NewUserAsync("other");
        var lobby = await host.Client.CreateLobbyAsync("lockable");

        var locked = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.Locked);
        await host.Client.LockLobbyAsync();
        Assert.True((await locked).Item1.Locked);

        Assert.Equal(ErrorCode.LobbyLocked, (await Assert.ThrowsAsync<EthernalException>(() => guest.Client.JoinLobbyAsync(lobby.Id))).Error);
        Assert.Equal(ErrorCode.NotInLobby, (await Assert.ThrowsAsync<EthernalException>(() => guest.Client.UnlockLobbyAsync())).Error);

        var unlocked = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.Unlocked);
        await host.Client.UnlockLobbyAsync();
        Assert.False((await unlocked).Item1.Locked);
        Assert.Equal(lobby.Id, (await guest.Client.JoinLobbyAsync(lobby.Id)).Id);
    }

    [Fact]
    public async Task Join_request_is_accepted_by_the_host()
    {
        await using var host = await hub.NewUserAsync("other");
        await using var guest = await hub.NewUserAsync("other");
        var lobby = await host.Client.CreateLobbyAsync("gated");
        await host.Client.LockLobbyAsync();

        var received = Wait.For<JoinRequestReceivedData>(h => host.Client.JoinRequestReceived += h, h => host.Client.JoinRequestReceived -= h);
        var pending = Wait.For<JoinRequestPendingData>(h => guest.Client.JoinRequestPending += h, h => guest.Client.JoinRequestPending -= h);
        var accepted = Wait.For<JoinRequestAcceptedData>(h => guest.Client.JoinRequestAccepted += h, h => guest.Client.JoinRequestAccepted -= h);
        var request = guest.Client.RequestJoinLobbyAsync(lobby.Id);

        var data = await received;
        Assert.Equal(guest.UserId, data.RequesterId);
        Assert.Equal(guest.Username, data.Username);
        Assert.Equal(lobby.Id, (await pending).LobbyId);

        await host.Client.RespondJoinRequestAsync(data.RequesterId, accept: true);
        var joined = await request;
        Assert.Equal(lobby.Id, (await accepted).Lobby.Id);
        Assert.Equal(lobby.Id, joined.Id);
        Assert.Contains(joined.Players, p => p.UserId == guest.UserId);
    }

    [Fact]
    public async Task Join_request_by_code_can_be_declined()
    {
        await using var host = await hub.NewUserAsync("other");
        await using var guest = await hub.NewUserAsync("other");
        var lobby = await host.Client.CreateLobbyAsync("gated2", isPrivate: true);
        await host.Client.LockLobbyAsync();

        var received = Wait.For<JoinRequestReceivedData>(h => host.Client.JoinRequestReceived += h, h => host.Client.JoinRequestReceived -= h);
        var rejected = Wait.For<JoinRequestRejectedData>(h => guest.Client.JoinRequestRejected += h, h => guest.Client.JoinRequestRejected -= h);
        var request = guest.Client.RequestJoinLobbyByCodeAsync(lobby.InviteCode!);
        await host.Client.RespondJoinRequestAsync((await received).RequesterId, accept: false);

        var ex = await Assert.ThrowsAsync<EthernalException>(() => request);
        Assert.Equal(ErrorCode.LobbyLocked, ex.Error);
        Assert.Equal(JoinRequestRejectReason.Declined, (await rejected).Reason);
    }

    [Fact]
    public async Task Join_request_cancel_is_confirmed_to_host_and_all_requester_sessions()
    {
        await using var host = await hub.NewUserAsync("other");
        await using var guest = await hub.NewUserAsync("other");
        await using var guest2 = new EthernalClient(new EthernalClientOptions { ServerUrl = hub.Url, ClientType = ClientType.Panel });
        await guest2.LoginAsync(guest.Username, "password123");
        var lobby = await host.Client.CreateLobbyAsync("gated3");
        await host.Client.LockLobbyAsync();

        var received = Wait.For<JoinRequestReceivedData>(h => host.Client.JoinRequestReceived += h, h => host.Client.JoinRequestReceived -= h);
        var hostSees = Wait.For<JoinRequestWithdrawnData>(h => host.Client.JoinRequestWithdrawn += h, h => host.Client.JoinRequestWithdrawn -= h);
        var guestSees = Wait.For<JoinRequestWithdrawnData>(h => guest.Client.JoinRequestWithdrawn += h, h => guest.Client.JoinRequestWithdrawn -= h);
        var guest2Sees = Wait.For<JoinRequestWithdrawnData>(h => guest2.JoinRequestWithdrawn += h, h => guest2.JoinRequestWithdrawn -= h);
        var request = guest.Client.RequestJoinLobbyAsync(lobby.Id);
        await received;

        await guest.Client.CancelJoinRequestAsync(lobby.Id);
        foreach (var data in new[] { await hostSees, await guestSees, await guest2Sees })
        {
            Assert.Equal(guest.UserId, data.RequesterId);
            Assert.Equal(lobby.Id, data.LobbyId);
            Assert.Equal(JoinRequestWithdrawReason.Cancelled, data.Reason);
        }

        var ex = await Assert.ThrowsAsync<EthernalException>(() => request);
        Assert.Equal(ErrorCode.JoinRequestNotFound, ex.Error);
        var again = await Assert.ThrowsAsync<EthernalException>(() => guest.Client.CancelJoinRequestAsync(lobby.Id));
        Assert.Equal(ErrorCode.JoinRequestNotFound, again.Error);
    }

    [Fact]
    public async Task GetJoinRequestsAsync_mirrors_both_sides_and_clears_after_decline()
    {
        await using var host = await hub.NewUserAsync("other");
        await using var guest = await hub.NewUserAsync("other");
        var lobby = await host.Client.CreateLobbyAsync("gated4");
        await host.Client.LockLobbyAsync();
        Assert.Empty((await host.Client.GetJoinRequestsAsync()).Incoming);

        var received = Wait.For<JoinRequestReceivedData>(h => host.Client.JoinRequestReceived += h, h => host.Client.JoinRequestReceived -= h);
        var pending = Wait.For<JoinRequestPendingData>(h => guest.Client.JoinRequestPending += h, h => guest.Client.JoinRequestPending -= h);
        var rejected = Wait.For<JoinRequestRejectedData>(h => guest.Client.JoinRequestRejected += h, h => guest.Client.JoinRequestRejected -= h);
        var request = guest.Client.RequestJoinLobbyAsync(lobby.Id);
        var rec = await received;
        var pend = await pending;
        Assert.True(pend.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60_000);
        Assert.Equal(pend.ExpiresAt, rec.ExpiresAt);

        var h = await host.Client.GetJoinRequestsAsync();
        var incoming = Assert.Single(h.Incoming);
        Assert.Equal(new[] { lobby.Id, guest.UserId, guest.Username, pend.ExpiresAt.ToString() }, new[] { incoming.LobbyId, incoming.RequesterId, incoming.Username, incoming.ExpiresAt.ToString() });
        Assert.Null(h.Outgoing);
        var g = await guest.Client.GetJoinRequestsAsync();
        Assert.Empty(g.Incoming);
        Assert.Equal(lobby.Id, g.Outgoing!.LobbyId);
        Assert.Equal(guest.UserId, g.Outgoing.RequesterId);

        await host.Client.RespondJoinRequestAsync(guest.UserId, accept: false);
        var ex = await Assert.ThrowsAsync<EthernalException>(() => request);
        Assert.Equal(ErrorCode.LobbyLocked, ex.Error);
        var rej = await rejected;
        Assert.Equal(lobby.Id, rej.LobbyId);
        Assert.Equal(JoinRequestRejectReason.Declined, rej.Reason);
        Assert.Null((await guest.Client.GetJoinRequestsAsync()).Outgoing);
        Assert.Empty((await host.Client.GetJoinRequestsAsync()).Incoming);
    }

    [Fact]
    public async Task Join_request_times_out_on_both_sides()
    {
        await using var h = await HubProcess.StartAsync(limitOverrides: new() { ["joinRequestTimeoutMs"] = 900 });
        await using var host = new EthernalClient(new EthernalClientOptions { ServerUrl = h.Url });
        await using var guest = new EthernalClient(new EthernalClientOptions { ServerUrl = h.Url });
        await host.RegisterAsync(HubFixture.UniqueName("th"), "password123");
        await guest.RegisterAsync(HubFixture.UniqueName("tg"), "password123");
        await host.RegisterGameAsync("other");
        await guest.RegisterGameAsync("other");
        var lobby = await host.CreateLobbyAsync("timeout");
        await host.LockLobbyAsync();

        var received = Wait.For<JoinRequestReceivedData>(x => host.JoinRequestReceived += x, x => host.JoinRequestReceived -= x);
        var withdrawn = Wait.For<JoinRequestWithdrawnData>(x => host.JoinRequestWithdrawn += x, x => host.JoinRequestWithdrawn -= x);
        var rejected = Wait.For<JoinRequestRejectedData>(x => guest.JoinRequestRejected += x, x => guest.JoinRequestRejected -= x);
        var request = guest.RequestJoinLobbyAsync(lobby.Id);
        var rec = await received;

        var ex = await Assert.ThrowsAsync<EthernalException>(() => request);
        Assert.Equal(ErrorCode.LobbyLocked, ex.Error);
        var rej = await rejected;
        Assert.Equal(lobby.Id, rej.LobbyId);
        Assert.Equal(JoinRequestRejectReason.Timeout, rej.Reason);
        var w = await withdrawn;
        Assert.Equal(lobby.Id, w.LobbyId);
        Assert.Equal(rec.RequesterId, w.RequesterId);
        Assert.Equal(JoinRequestWithdrawReason.Timeout, w.Reason);
        Assert.Empty((await host.GetJoinRequestsAsync()).Incoming);
        Assert.Null((await guest.GetJoinRequestsAsync()).Outgoing);
    }

    [Fact]
    public async Task Kick_notifies_the_player_and_removes_them()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("kick");
        await guest.Client.JoinLobbyAsync(lobby.Id);

        Assert.Equal(ErrorCode.NotHost, (await Assert.ThrowsAsync<EthernalException>(() => guest.Client.KickPlayerAsync(host.UserId))).Error);
        Assert.Equal(ErrorCode.CannotKickSelf, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.KickPlayerAsync(host.UserId))).Error);

        var kicked = Wait.For<PlayerKickedData>(h => guest.Client.PlayerKicked += h, h => guest.Client.PlayerKicked -= h);
        var changed = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => host.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.Kicked);
        await host.Client.KickPlayerAsync(guest.UserId);

        Assert.Equal(lobby.Id, (await kicked).LobbyId);
        Assert.Single((await changed).Item1.Players);
        Assert.Null((await guest.Client.GetSessionStateAsync()).Lobby);
    }

    [Fact]
    public async Task TransferHost_and_host_leaving()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("transfer");
        await guest.Client.JoinLobbyAsync(lobby.Id);

        Assert.Equal(ErrorCode.AlreadyHost, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.TransferHostAsync(host.UserId))).Error);

        var transferred = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => guest.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.HostTransferred);
        await host.Client.TransferHostAsync(guest.UserId);
        var (after, _) = await transferred;
        Assert.Equal(guest.UserId, after.HostId);
        Assert.Contains(after.Players, p => p.UserId == guest.UserId && p.IsHost);

        Assert.Equal(ErrorCode.NotHost, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.KickPlayerAsync(guest.UserId))).Error);
    }

    [Fact]
    public async Task SetLobbyState_in_progress_then_closed()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("state");
        await guest.Client.JoinLobbyAsync(lobby.Id);

        Assert.Equal(ErrorCode.NotHost, (await Assert.ThrowsAsync<EthernalException>(() => guest.Client.SetLobbyStateAsync(LobbyStatus.InProgress))).Error);
        Assert.Equal(ErrorCode.InvalidInput, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.SetLobbyStateAsync(LobbyStatus.Full))).Error);

        var inProgress = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => guest.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item2 == LobbyChangeReason.StateChanged);
        await host.Client.SetLobbyStateAsync(LobbyStatus.InProgress);
        Assert.Equal(LobbyStatus.InProgress, (await inProgress).Item1.Status);
        Assert.DoesNotContain(await host.Client.ListLobbiesAsync(), l => l.Id == lobby.Id);

        var closed = Wait.For<(Lobby, LobbyChangeReason?)>(
            h => guest.Client.LobbyChanged += (l, r) => h((l, r)), _ => { }, t => t.Item1.Status == LobbyStatus.Closed);
        await host.Client.SetLobbyStateAsync(LobbyStatus.Closed);
        Assert.Equal(LobbyStatus.Closed, (await closed).Item1.Status);
    }

    [Fact]
    public async Task Unknown_reason_strings_never_break_lobby_updates()
    {
        // LobbyChanged is raised with a null/Unknown reason rather than failing when the reason is not known
        await using var host = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("reasons");
        Assert.Equal(LobbyChangeReason.Unknown, WireEnumConverter<LobbyChangeReason>.Parse("something_new"));
        Assert.Equal(LobbyChangeReason.ServerRebound, WireEnumConverter<LobbyChangeReason>.Parse("server_rebound"));
        Assert.NotNull(lobby);
    }
}
