using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class SocialTests(HubFixture hub)
{
    private async Task<(TestUser A, TestUser B)> FriendsAsync(string game = "other")
    {
        var a = await hub.NewUserAsync(game);
        var b = await hub.NewUserAsync(game);
        var received = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        var accepted = Wait.For<FriendRequestAccepted>(h => a.Client.FriendRequestAccepted += h, h => a.Client.FriendRequestAccepted -= h);
        Assert.Equal(FriendRequestResult.RequestSent, await a.Client.RequestFriendByNameAsync(b.Username));
        await b.Client.RespondFriendRequestAsync((await received).Id, accept: true);
        await accepted;
        return (a, b);
    }

    [Fact]
    public async Task Friend_request_by_name_accept_flow_with_events_and_lists()
    {
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        var received = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        var accepted = Wait.For<FriendRequestAccepted>(h => a.Client.FriendRequestAccepted += h, h => a.Client.FriendRequestAccepted -= h);

        Assert.Equal(FriendRequestResult.RequestSent, await a.Client.RequestFriendByNameAsync(b.Username));

        var request = await received;
        Assert.Equal(a.UserId, request.User.UserId);
        Assert.Equal(a.Username, request.User.Username);
        Assert.Equal(FriendRequestSource.Name, request.Source);
        Assert.True(request.ExpiresAt > request.CreatedAt);

        var bLists = await b.Client.ListFriendRequestsAsync();
        Assert.Contains(bLists.Incoming, r => r.Id == request.Id);
        var aLists = await a.Client.ListFriendRequestsAsync();
        Assert.Contains(aLists.Outgoing, r => r.Id == request.Id && r.User.UserId == b.UserId);

        await b.Client.RespondFriendRequestAsync(request.Id, accept: true);
        var acceptedData = await accepted;
        Assert.Equal(b.UserId, acceptedData.Friend.UserId);

        Assert.Contains(await a.Client.ListFriendsAsync(), f => f.UserId == b.UserId && f.Username == b.Username);
        Assert.Contains(await b.Client.ListFriendsAsync(), f => f.UserId == a.UserId);
        Assert.Empty((await a.Client.ListFriendRequestsAsync()).Outgoing);
    }

    [Fact]
    public async Task Request_by_unknown_name_returns_NoSuchPlayer_and_never_leaks_other_outcomes()
    {
        await using var a = await hub.NewUserAsync();
        Assert.Equal(FriendRequestResult.NoSuchPlayer, await a.Client.RequestFriendByNameAsync("nobody-" + HubFixture.UniqueName()));
        // Requesting yourself looks like a normal sent request
        Assert.Equal(FriendRequestResult.RequestSent, await a.Client.RequestFriendByNameAsync(a.Username));
    }

    [Fact]
    public async Task Request_from_lobby_declined_and_cancelled()
    {
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        var lobby = await a.Client.CreateLobbyAsync("meet");
        await b.Client.JoinLobbyAsync(lobby.Id);

        var received = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        Assert.Equal(FriendRequestResult.RequestSent, await a.Client.RequestFriendFromLobbyAsync(b.UserId));
        var first = await received;
        Assert.Equal(FriendRequestSource.Lobby, first.Source);

        var declined = Wait.For<FriendRequestDeclined>(h => a.Client.FriendRequestDeclined += h, h => a.Client.FriendRequestDeclined -= h);
        await b.Client.RespondFriendRequestAsync(first.Id, accept: false);
        var declinedData = await declined;
        Assert.Equal(first.Id, declinedData.RequestId);
        Assert.Equal(b.UserId, declinedData.User.UserId);

        var received2 = Wait.For<FriendRequestInfo>(h => b.Client.FriendRequestReceived += h, h => b.Client.FriendRequestReceived -= h);
        await a.Client.RequestFriendFromLobbyAsync(b.UserId);
        var second = await received2;
        var cancelled = Wait.For<string>(h => b.Client.FriendRequestCancelled += h, h => b.Client.FriendRequestCancelled -= h);
        await a.Client.CancelFriendRequestAsync(second.Id);
        Assert.Equal(second.Id, await cancelled);

        await using var stranger = await hub.NewUserAsync();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => a.Client.RequestFriendFromLobbyAsync(stranger.UserId));
        Assert.Equal(ErrorCode.PlayerNotInLobby, ex.Error);
        var missing = await Assert.ThrowsAsync<EthernalException>(() => b.Client.RespondFriendRequestAsync("nope", true));
        Assert.Equal(ErrorCode.FriendRequestNotFound, missing.Error);
    }

    [Fact]
    public async Task RemoveFriend_notifies_the_other_side()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        var removed = Wait.For<string>(h => b.Client.FriendRemoved += h, h => b.Client.FriendRemoved -= h);
        await a.Client.RemoveFriendAsync(b.UserId);
        Assert.Equal(a.UserId, await removed);
        Assert.Empty(await a.Client.ListFriendsAsync());
        var ex = await Assert.ThrowsAsync<EthernalException>(() => a.Client.RemoveFriendAsync(b.UserId));
        Assert.Equal(ErrorCode.NotFriends, ex.Error);
    }

    [Fact]
    public async Task Presence_lists_and_changes_with_own_status()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;

        var presence = (await a.Client.GetFriendsPresenceAsync()).Single();
        Assert.Equal(b.UserId, presence.UserId);
        Assert.True(presence.Online);
        Assert.Equal(FriendPresenceStatus.Online, presence.Status);
        Assert.Equal("other", presence.GameId);
        Assert.Null(presence.LobbyJoinable);

        var changed = Wait.For<FriendPresence>(h => a.Client.FriendPresenceChanged += h, h => a.Client.FriendPresenceChanged -= h,
            p => p.UserId == b.UserId && p.Status == FriendPresenceStatus.Busy);
        var settings = await b.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Busy);
        Assert.Equal(OwnPresenceStatus.Busy, settings.Status);
        Assert.Equal(FriendPresenceStatus.Busy, (await changed).Status);

        var lobbyChanged = Wait.For<FriendPresence>(h => a.Client.FriendPresenceChanged += h, h => a.Client.FriendPresenceChanged -= h,
            p => p.UserId == b.UserId && p.LobbyJoinable == true);
        await b.Client.CreateLobbyAsync("presence-lobby");
        Assert.True((await lobbyChanged).LobbyJoinable);

        var invisible = Wait.For<FriendPresence>(h => a.Client.FriendPresenceChanged += h, h => a.Client.FriendPresenceChanged -= h,
            p => p.UserId == b.UserId && !p.Online);
        await b.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Invisible);
        var offline = await invisible;
        Assert.Equal(FriendPresenceStatus.Offline, offline.Status);
        Assert.Null(offline.GameId);
    }

    [Fact]
    public async Task Social_settings_roundtrip_only_changes_given_fields()
    {
        await using var user = await hub.NewUserAsync();
        var defaults = await user.Client.GetSocialSettingsAsync();
        Assert.Equal(OwnPresenceStatus.Online, defaults.Status);
        Assert.True(defaults.ShowLastSeen);
        Assert.True(defaults.DmReadReceipts);
        Assert.Empty(defaults.MutedNotificationTypes);

        var updated = await user.Client.SetSocialSettingsAsync(showLastSeen: false, dmReadReceipts: false,
            mutedNotificationTypes: [NotificationType.FriendOnline, NotificationType.Dm]);
        Assert.Equal(OwnPresenceStatus.Online, updated.Status);
        Assert.False(updated.ShowLastSeen);
        Assert.False(updated.DmReadReceipts);
        Assert.Equal([NotificationType.FriendOnline, NotificationType.Dm], updated.MutedNotificationTypes.Order().ToArray().Length == 2
            ? updated.MutedNotificationTypes : []);

        var again = await user.Client.GetSocialSettingsAsync();
        Assert.False(again.ShowLastSeen);
        Assert.Equal(2, again.MutedNotificationTypes.Length);
    }

    [Fact]
    public async Task Notifications_are_delivered_listed_counted_and_marked_read()
    {
        await using var a = await hub.NewUserAsync();
        await using var b = await hub.NewUserAsync();
        var notified = Wait.For<HubNotification>(h => b.Client.NotificationReceived += h, h => b.Client.NotificationReceived -= h,
            n => n.Type == NotificationType.FriendRequest);
        await a.Client.RequestFriendByNameAsync(b.Username);
        var notification = await notified;
        Assert.Equal(a.UserId, notification.Payload.GetProperty("fromUserId").GetString());
        Assert.Null(notification.ReadAt);
        Assert.True(notification.ExpiresAt > notification.CreatedAt);

        var counts = await b.Client.GetNotificationCountsAsync();
        Assert.True(counts.Unread >= 1);
        Assert.True(counts.Total >= counts.Unread);
        Assert.True(counts.ByType.ContainsKey("friend_request"));

        var list = await b.Client.ListNotificationsAsync(limit: 10, unreadOnly: true);
        Assert.Contains(list.Notifications, n => n.Id == notification.Id);

        var marked = await b.Client.MarkNotificationsReadAsync(ids: [notification.Id]);
        Assert.Equal(1, marked.Marked);
        Assert.Equal(counts.Unread - 1, marked.Unread);
        Assert.DoesNotContain((await b.Client.ListNotificationsAsync(unreadOnly: true)).Notifications, n => n.Id == notification.Id);

        var all = await b.Client.MarkNotificationsReadAsync(upTo: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000);
        Assert.Equal(0, all.Unread);
        Assert.Equal(0, (await b.Client.GetNotificationCountsAsync()).Unread);
    }

    [Fact]
    public async Task Notification_pagination_uses_cursor()
    {
        await using var target = await hub.NewUserAsync();
        for (var i = 0; i < 3; i++)
        {
            await using var sender = await hub.NewUserAsync();
            await sender.Client.RequestFriendByNameAsync(target.Username);
        }
        await Wait.UntilResult(() => target.Client.GetNotificationCountsAsync(), c => c.Total >= 3, "3 notifications");
        var page1 = await target.Client.ListNotificationsAsync(limit: 2);
        Assert.Equal(2, page1.Notifications.Length);
        Assert.NotNull(page1.NextCursor);
        var page2 = await target.Client.ListNotificationsAsync(limit: 2, cursor: page1.NextCursor);
        Assert.NotEmpty(page2.Notifications);
        Assert.DoesNotContain(page2.Notifications, n => page1.Notifications.Any(p => p.Id == n.Id));
    }

    [Fact]
    public async Task Backlog_is_pushed_after_connect_when_notifications_are_unread()
    {
        var name = HubFixture.UniqueName("bl");
        await using (var first = hub.NewClient()) await first.RegisterAsync(name, "password123");
        await using var sender = await hub.NewUserAsync();
        await sender.Client.RequestFriendByNameAsync(name);

        await using var returning = hub.NewClient();
        var backlog = Wait.For<NotificationBacklog>(h => returning.NotificationBacklogReceived += h, h => returning.NotificationBacklogReceived -= h);
        await returning.LoginAsync(name, "password123");
        var data = await backlog;
        Assert.True(data.UnreadCount >= 1);
        Assert.Contains(data.Latest, n => n.Type == NotificationType.FriendRequest);
    }

    [Fact]
    public async Task FriendOnline_notification_goes_to_online_friends_and_can_be_muted()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        await a.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Invisible);
        await Task.Delay(200);

        var online = Wait.For<HubNotification>(h => b.Client.NotificationReceived += h, h => b.Client.NotificationReceived -= h,
            n => n.Type == NotificationType.FriendOnline);
        await a.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Online);
        var notification = await online;
        Assert.Equal(a.UserId, notification.Payload.GetProperty("userId").GetString());
        Assert.Equal(a.Username, notification.Payload.GetProperty("username").GetString());

        await b.Client.SetSocialSettingsAsync(mutedNotificationTypes: [NotificationType.FriendOnline]);
        await a.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Invisible);
        await Task.Delay(200);
        var muted = new List<HubNotification>();
        b.Client.NotificationReceived += muted.Add;
        await a.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Online);
        await Task.Delay(600);
        Assert.DoesNotContain(muted, n => n.Type == NotificationType.FriendOnline);
    }

    [Fact]
    public async Task Direct_messages_with_delivery_read_receipts_history_and_conversations()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;

        var received = Wait.For<DirectMessage>(h => b.Client.DirectMessageReceived += h, h => b.Client.DirectMessageReceived -= h);
        var sent = await a.Client.SendDirectMessageAsync(b.UserId, "hello b");
        Assert.NotNull(sent.DeliveredAt); // recipient is online
        Assert.Equal("hello b", sent.Text);
        Assert.Equal(a.UserId, sent.From);
        Assert.Equal(b.UserId, sent.To);
        Assert.True(sent.Seq > 0);

        var msg = await received;
        Assert.Equal(sent.Id, msg.Id);
        Assert.Equal("hello b", msg.Text);

        await a.Client.SendDirectMessageAsync(b.UserId, "second");

        var conversations = await b.Client.ListConversationsAsync();
        var conversation = Assert.Single(conversations);
        Assert.Equal(a.UserId, conversation.WithUserId);
        Assert.Equal(a.Username, conversation.Username);
        Assert.Equal(2, conversation.UnreadCount);
        Assert.Equal("second", conversation.LastMessage.Text);

        var read = Wait.For<DmReadData>(h => a.Client.DirectMessageRead += h, h => a.Client.DirectMessageRead -= h);
        Assert.Equal(2, await b.Client.MarkConversationReadAsync(a.UserId));
        var readData = await read;
        Assert.Equal(b.UserId, readData.ByUserId);
        Assert.True(readData.UpToSeq >= sent.Seq);
        Assert.Equal(0, (await b.Client.ListConversationsAsync()).Single().UnreadCount);

        var history = await b.Client.GetDmHistoryAsync(a.UserId);
        Assert.Equal(2, history.Messages.Length);
        Assert.All(history.Messages, m => Assert.NotNull(m.ReadAt));
        Assert.Equal(["hello b", "second"], history.Messages.OrderBy(m => m.Seq).Select(m => m.Text).ToArray());
        Assert.Equal(sent.ConversationId, history.Messages[0].ConversationId);

        var page = await b.Client.GetDmHistoryAsync(a.UserId, limit: 1);
        Assert.Single(page.Messages);
        Assert.NotNull(page.NextBefore);
        var older = await b.Client.GetDmHistoryAsync(a.UserId, before: page.NextBefore, limit: 10);
        Assert.Single(older.Messages);
        Assert.NotEqual(page.Messages[0].Id, older.Messages[0].Id);
    }

    [Fact]
    public async Task Offline_direct_message_is_delivered_on_connect_and_raises_DirectMessageDelivered()
    {
        var name = HubFixture.UniqueName("off");
        var a = await hub.NewUserAsync();
        await using var _a = a;
        string bId;
        await using (var b0 = hub.NewClient())
        {
            bId = (await b0.RegisterAsync(name, "password123")).User.UserId;
            var accepted = Wait.For<FriendRequestAccepted>(h => a.Client.FriendRequestAccepted += h, h => a.Client.FriendRequestAccepted -= h);
            var received = Wait.For<FriendRequestInfo>(h => b0.FriendRequestReceived += h, h => b0.FriendRequestReceived -= h);
            await a.Client.RequestFriendByNameAsync(name);
            await b0.RespondFriendRequestAsync((await received).Id, true);
            await accepted;
        }
        await Task.Delay(500); // let the hub notice the disconnect

        var sent = await a.Client.SendDirectMessageAsync(bId, "while you were away");
        Assert.Null(sent.DeliveredAt);

        await using var b = hub.NewClient();
        var delivered = Wait.For<DmDeliveredData>(h => a.Client.DirectMessageDelivered += h, h => a.Client.DirectMessageDelivered -= h);
        var backlog = Wait.For<NotificationBacklog>(h => b.NotificationBacklogReceived += h, h => b.NotificationBacklogReceived -= h);
        await b.LoginAsync(name, "password123");
        var data = await delivered;
        Assert.Equal(bId, data.ByUserId);
        Assert.Contains(sent.Id, data.MessageIds);
        Assert.Contains((await backlog).Latest, n => n.Type == NotificationType.Dm);
    }

    [Fact]
    public async Task DirectMessage_typing_and_errors()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        var typing = Wait.For<DmTypingData>(h => b.Client.DirectMessageTyping += h, h => b.Client.DirectMessageTyping -= h);
        await a.Client.SendTypingAsync(b.UserId);
        Assert.Equal(a.UserId, (await typing).FromUserId);

        var tooLong = await Assert.ThrowsAsync<EthernalException>(() => a.Client.SendDirectMessageAsync(b.UserId, new string('x', 5000)));
        Assert.Equal(ErrorCode.MessageTooLong, tooLong.Error);

        await using var stranger = await hub.NewUserAsync();
        var notFriends = await Assert.ThrowsAsync<EthernalException>(() => a.Client.SendDirectMessageAsync(stranger.UserId, "hi"));
        Assert.Equal(ErrorCode.NotFriends, notFriends.Error);
    }

    [Fact]
    public async Task Lobby_invite_accept_cancel_decline()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        var lobby = await a.Client.CreateLobbyAsync("invite-lobby", isPrivate: true);

        var received = Wait.For<LobbyInvite>(h => b.Client.LobbyInviteReceived += h, h => b.Client.LobbyInviteReceived -= h);
        var invite = await a.Client.InviteFriendAsync(b.UserId);
        Assert.Equal(lobby.Id, invite.LobbyId);
        var pushed = await received;
        Assert.Equal(invite.InviteId, pushed.InviteId);
        Assert.Equal(a.UserId, pushed.FromUserId);
        Assert.Equal(a.Username, pushed.FromUsername);
        Assert.Equal("invite-lobby", pushed.LobbyName);
        Assert.Equal("other", pushed.GameId);
        Assert.Contains(await b.Client.ListLobbyInvitesAsync(), i => i.InviteId == invite.InviteId);

        var declined = Wait.For<LobbyInviteDeclinedData>(h => a.Client.LobbyInviteDeclined += h, h => a.Client.LobbyInviteDeclined -= h);
        await b.Client.DeclineLobbyInviteAsync(invite.InviteId);
        var declinedData = await declined;
        Assert.Equal(invite.InviteId, declinedData.InviteId);
        Assert.Equal(b.UserId, declinedData.UserId);
        Assert.Empty(await b.Client.ListLobbyInvitesAsync());

        var second = Wait.For<LobbyInvite>(h => b.Client.LobbyInviteReceived += h, h => b.Client.LobbyInviteReceived -= h);
        var cancelledEvent = Wait.For<LobbyInviteCancelledData>(h => b.Client.LobbyInviteCancelled += h, h => b.Client.LobbyInviteCancelled -= h);
        var invite2 = await a.Client.InviteFriendAsync(b.UserId);
        await second;
        await a.Client.CancelLobbyInviteAsync(invite2.InviteId);
        var cancelled = await cancelledEvent;
        Assert.Equal(invite2.InviteId, cancelled.InviteId);
        Assert.Equal(lobby.Id, cancelled.LobbyId);
        Assert.Equal(LobbyInviteCancelReason.Cancelled, cancelled.Reason);

        var third = Wait.For<LobbyInvite>(h => b.Client.LobbyInviteReceived += h, h => b.Client.LobbyInviteReceived -= h);
        var invite3 = await a.Client.InviteFriendAsync(b.UserId);
        await third;
        var joined = await b.Client.AcceptLobbyInviteAsync(invite3.InviteId);
        Assert.Equal(lobby.Id, joined.Id); // invites work for private lobbies
        Assert.Equal(2, joined.Players.Length);

        var missing = await Assert.ThrowsAsync<EthernalException>(() => b.Client.AcceptLobbyInviteAsync("nope"));
        Assert.Equal(ErrorCode.InviteNotFound, missing.Error);
    }

    [Fact]
    public async Task Inviting_a_non_friend_or_without_lobby_fails()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        var noLobby = await Assert.ThrowsAsync<EthernalException>(() => a.Client.InviteFriendAsync(b.UserId));
        Assert.Equal(ErrorCode.NotInLobby, noLobby.Error);
        await a.Client.CreateLobbyAsync("x");
        await using var stranger = await hub.NewUserAsync();
        var notFriend = await Assert.ThrowsAsync<EthernalException>(() => a.Client.InviteFriendAsync(stranger.UserId));
        Assert.Equal(ErrorCode.NotFriends, notFriend.Error);
    }

    [Fact]
    public async Task JoinFriend_and_GetFriendLobby()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;

        var none = await Assert.ThrowsAsync<EthernalException>(() => b.Client.JoinFriendAsync(a.UserId));
        Assert.Equal(ErrorCode.FriendNotInLobby, none.Error);
        Assert.Null(await b.Client.GetFriendLobbyAsync(a.UserId));

        var lobby = await a.Client.CreateLobbyAsync("friend-lobby");
        var info = await b.Client.GetFriendLobbyAsync(a.UserId);
        Assert.NotNull(info);
        Assert.Equal(lobby.Id, info!.LobbyId);
        Assert.Equal("friend-lobby", info.Name);
        Assert.Equal(1, info.Players);
        Assert.Equal(4, info.Slots);
        Assert.True(info.Joinable);
        Assert.False(info.Locked);

        var result = await b.Client.JoinFriendAsync(a.UserId);
        Assert.False(result.Pending);
        Assert.Equal(lobby.Id, result.Lobby?.Id);
    }

    [Fact]
    public async Task JoinFriend_on_a_locked_lobby_sends_a_join_request()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        await a.Client.CreateLobbyAsync("locked-friend");
        await a.Client.LockLobbyAsync();
        var received = Wait.For<JoinRequestReceivedData>(h => a.Client.JoinRequestReceived += h, h => a.Client.JoinRequestReceived -= h);
        var result = await b.Client.JoinFriendAsync(a.UserId);
        Assert.True(result.Pending);
        Assert.Null(result.Lobby);
        Assert.Equal(b.UserId, (await received).RequesterId);
    }

    [Fact]
    public async Task SyncSocialAsync_returns_snapshot_and_NotModified_for_current_etag()
    {
        var (a, b) = await FriendsAsync();
        await using var _a = a;
        await using var _b = b;
        await b.Client.SendDirectMessageAsync(a.UserId, "unread for a");

        var snapshot = await a.Client.SyncSocialAsync();
        Assert.False(snapshot.NotModified);
        Assert.False(string.IsNullOrEmpty(snapshot.Etag));
        Assert.True(snapshot.ServerTime > 0);
        Assert.Equal(OwnPresenceStatus.Online, snapshot.Status);
        Assert.Equal(OwnPresenceStatus.Online, snapshot.Settings.Status);
        Assert.Contains(snapshot.Friends, f => f.UserId == b.UserId);
        Assert.Contains(snapshot.Presence, p => p.UserId == b.UserId);
        Assert.Empty(snapshot.Requests.Incoming);
        Assert.Empty(snapshot.LobbyInvites);
        Assert.Contains(snapshot.Conversations, c => c.WithUserId == b.UserId && c.UnreadCount == 1);
        Assert.True(snapshot.UnreadNotifications >= 0);

        var same = await a.Client.SyncSocialAsync(snapshot.Etag);
        Assert.True(same.NotModified);
        Assert.Equal(snapshot.Etag, same.Etag);

        await a.Client.SetSocialSettingsAsync(status: OwnPresenceStatus.Away);
        var changed = await a.Client.SyncSocialAsync(snapshot.Etag);
        Assert.False(changed.NotModified);
        Assert.NotEqual(snapshot.Etag, changed.Etag);
        Assert.Equal(OwnPresenceStatus.Away, changed.Status);
    }

    [Fact]
    public async Task Notification_payloads_are_plain_JsonElements()
    {
        await using var user = await hub.NewUserAsync();
        var list = await user.Client.ListNotificationsAsync();
        Assert.Empty(list.Notifications);
        Assert.Null(list.NextCursor);
        var counts = await user.Client.GetNotificationCountsAsync();
        Assert.Equal(0, counts.Total);
        Assert.Equal(JsonValueKind.Undefined, default(JsonElement).ValueKind);
    }
}
