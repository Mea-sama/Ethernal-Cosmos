using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class DmReadTests(HubFixture hub)
{
    private async Task<(TestUser A, TestUser B)> FriendsAsync()
    {
        var a = await hub.NewUserAsync("other");
        var b = await hub.NewUserAsync("other");
        var received = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        var accepted = Wait.For<FriendRequestAccepted>(h => a.Client.FriendRequestAccepted += h, h => a.Client.FriendRequestAccepted -= h);
        await a.Client.RequestFriendByNameAsync(b.Username);
        await b.Client.RespondFriendRequestAsync((await received).Id, accept: true);
        await accepted;
        return (a, b);
    }

    private static async Task<long[]> SendAsync(TestUser from, TestUser to, int count, string prefix = "m")
    {
        var seqs = new List<long>();
        for (var i = 1; i <= count; i++) seqs.Add((await from.Client.SendDirectMessageAsync(to.UserId, $"{prefix}{i}")).Seq);
        return [.. seqs];
    }

    private async Task<EthernalClient> SecondSessionAsync(TestUser user)
    {
        var client = new EthernalClient(new EthernalClientOptions { ServerUrl = hub.Url, ClientType = ClientType.Panel, RequestTimeout = TimeSpan.FromSeconds(8) });
        await client.LoginAsync(user.Username, "password123");
        return client;
    }

    [Fact]
    public async Task Unread_badge_flow_unread_open_and_second_session_sync()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        await using var b2 = await SecondSessionAsync(b);

        var seqs = await SendAsync(a, b, 12);

        var unread = await b.Client.GetDmUnreadAsync();
        Assert.Equal(12, unread.TotalUnread);
        var chat = Assert.Single(unread.Conversations);
        Assert.Equal(a.UserId, chat.WithUserId);
        Assert.Equal(12, chat.UnreadCount);
        Assert.Equal(seqs[0], chat.FirstUnreadSeq);
        Assert.Equal(seqs[^1], chat.LastSeq);
        Assert.True(chat.LastMessageAt > 0);
        Assert.Equal(0, Assert.Single(await b.Client.ListConversationsAsync()).LastReadSeq);

        var synced = Wait.For<DmReadState>(h => b2.DirectMessageReadStateChanged += h, h => b2.DirectMessageReadStateChanged -= h);
        var opened = await b.Client.OpenDmConversationAsync(a.UserId);

        Assert.Equal(10, opened.Messages.Length);
        Assert.Equal(seqs[2..], opened.Messages.Select(m => m.Seq).ToArray());
        Assert.NotNull(opened.NextBefore);
        Assert.Equal(12, opened.UnreadCount);
        Assert.Equal(seqs[0], opened.FirstUnreadSeq);
        Assert.Equal(0, opened.LastReadSeq);

        var state = await synced;
        Assert.Equal(a.UserId, state.WithUserId);
        Assert.Equal(0, state.UnreadCount);
        Assert.Equal(0, state.TotalUnread);
        Assert.Equal(seqs[^1], state.LastReadSeq);

        var after = await b.Client.GetDmUnreadAsync();
        Assert.Equal(0, after.TotalUnread);
        Assert.Empty(after.Conversations);
        Assert.Equal(seqs[^1], Assert.Single(await b.Client.ListConversationsAsync()).LastReadSeq);

        var again = await b.Client.OpenDmConversationAsync(a.UserId, limit: 3);
        Assert.Equal(3, again.Messages.Length);
        Assert.Equal(0, again.UnreadCount);
        Assert.Null(again.FirstUnreadSeq);
        Assert.Equal(seqs[^1], again.LastReadSeq);
    }

    [Fact]
    public async Task MarkDmReadAsync_partial_then_full_updates_state_and_other_sessions()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        await using var b2 = await SecondSessionAsync(b);
        var seqs = await SendAsync(a, b, 5);

        var synced = Wait.For<DmReadState>(h => b2.DirectMessageReadStateChanged += h, h => b2.DirectMessageReadStateChanged -= h);
        var partial = await b.Client.MarkDmReadAsync(a.UserId, upToSeq: seqs[2]);
        Assert.Equal(3, partial.Marked);
        Assert.Equal(2, partial.UnreadCount);
        Assert.Equal(2, partial.TotalUnread);
        Assert.Equal(seqs[2], partial.LastReadSeq);
        var pushed = await synced;
        Assert.Equal(2, pushed.UnreadCount);
        Assert.Equal(seqs[2], pushed.LastReadSeq);

        var chat = Assert.Single((await b.Client.GetDmUnreadAsync()).Conversations);
        Assert.Equal(seqs[3], chat.FirstUnreadSeq);
        Assert.Equal(2, chat.UnreadCount);

        var rest = await b.Client.MarkDmReadAsync(a.UserId);
        Assert.Equal(2, rest.Marked);
        Assert.Equal(0, rest.UnreadCount);
        Assert.Equal(seqs[4], rest.LastReadSeq);

        var noop = await b.Client.MarkDmReadAsync(a.UserId);
        Assert.Equal(0, noop.Marked);
        Assert.Equal(0, noop.TotalUnread);
    }

    [Fact]
    public async Task History_reports_peerLastReadSeq_unless_receipts_are_disabled()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        var seqs = await SendAsync(a, b, 2);

        var before = await a.Client.GetDmHistoryAsync(b.UserId);
        Assert.Equal(0, before.PeerLastReadSeq);

        await b.Client.OpenDmConversationAsync(a.UserId);
        var read = await a.Client.GetDmHistoryAsync(b.UserId);
        Assert.Equal(seqs[^1], read.PeerLastReadSeq);

        await b.Client.SetSocialSettingsAsync(dmReadReceipts: false);
        Assert.Null((await a.Client.GetDmHistoryAsync(b.UserId)).PeerLastReadSeq);
    }

    [Fact]
    public async Task Dm_read_requires_friendship()
    {
        await using var a = await hub.NewUserAsync("other");
        await using var b = await hub.NewUserAsync("other");
        var ex = await Assert.ThrowsAsync<EthernalException>(() => a.Client.OpenDmConversationAsync(b.UserId));
        Assert.Equal(ErrorCode.NotFriends, ex.Error);
        await Assert.ThrowsAsync<EthernalException>(() => a.Client.MarkDmReadAsync(b.UserId, 1));
    }
}
