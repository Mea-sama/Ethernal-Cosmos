using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class KickAndBlockTests(HubFixture hub)
{
    [Fact]
    public async Task Host_kick_carries_a_reason_and_blocks_rejoining_until_unkicked()
    {
        await using var host = await hub.NewUserAsync();
        await using var guest = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("kick");
        await guest.Client.JoinLobbyAsync(lobby.Id);

        var kicked = Wait.For<PlayerKickedData>(h => guest.Client.PlayerKicked += h, h => guest.Client.PlayerKicked -= h);
        await host.Client.KickPlayerAsync(guest.UserId, "too loud");
        var data = await kicked;
        Assert.Equal(lobby.Id, data.LobbyId);
        Assert.Equal("too loud", data.Reason);

        var again = await Assert.ThrowsAsync<EthernalException>(() => guest.Client.JoinLobbyAsync(lobby.Id));
        Assert.Equal(ErrorCode.KickedFromLobby, again.Error);

        await host.Client.UnkickPlayerAsync(guest.UserId);
        Assert.Equal(2, (await guest.Client.JoinLobbyAsync(lobby.Id)).Players.Length);

        // a kick without a reason has none
        var plain = Wait.For<PlayerKickedData>(h => guest.Client.PlayerKicked += h, h => guest.Client.PlayerKicked -= h);
        await host.Client.KickPlayerAsync(guest.UserId);
        Assert.Null((await plain).Reason);
    }

    [Fact]
    public async Task Block_list_unblock_and_friendship_removal()
    {
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        await using var c = await hub.NewUserAsync();
        var received = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        await a.Client.RequestFriendByNameAsync(b.Username);
        await b.Client.RespondFriendRequestAsync((await received).Id, accept: true);
        Assert.Contains(await a.Client.ListFriendsAsync(), f => f.UserId == b.UserId);

        var blocked = await a.Client.BlockUserAsync(b.UserId);
        Assert.Equal(b.UserId, blocked.UserId);
        Assert.Equal(b.Username, blocked.Username);
        Assert.True(blocked.BlockedAt > 0);
        await a.Client.BlockUserAsync(b.UserId); // idempotent
        Assert.DoesNotContain(await a.Client.ListFriendsAsync(), f => f.UserId == b.UserId);
        Assert.Equal([b.UserId], (await a.Client.GetBlockedUsersAsync()).Select(u => u.UserId).ToArray());
        Assert.Empty(await b.Client.GetBlockedUsersAsync());

        await a.Client.UnblockUserAsync(b.UserId);
        await a.Client.UnblockUserAsync(b.UserId); // idempotent
        Assert.Empty(await a.Client.GetBlockedUsersAsync());
        Assert.DoesNotContain(await a.Client.ListFriendsAsync(), f => f.UserId == b.UserId);

        var self = await Assert.ThrowsAsync<EthernalException>(() => a.Client.BlockUserAsync(a.UserId));
        Assert.Equal(ErrorCode.CannotTargetSelf, self.Error);
        var unknown = await Assert.ThrowsAsync<EthernalException>(() => c.Client.BlockUserAsync("00000000-0000-0000-0000-000000000000"));
        Assert.Equal(ErrorCode.UserNotFound, unknown.Error);
    }
}
