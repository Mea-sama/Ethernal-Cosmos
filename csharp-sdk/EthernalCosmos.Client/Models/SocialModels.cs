using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

/// <summary>A friend or other user reference.</summary>
public sealed class FriendInfo
{
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

/// <summary>An open friend request.</summary>
public sealed class FriendRequestInfo
{
    /// <summary>Unique id.</summary>
    [JsonPropertyName("id")]        public string     Id        { get; init; } = "";
    /// <summary>Sender for incoming requests, recipient for outgoing ones.</summary>
    [JsonPropertyName("user")]      public FriendInfo User      { get; init; } = new();
    /// <summary>How the request was created.</summary>
    [JsonPropertyName("source")]    public FriendRequestSource Source { get; init; }
    /// <summary>Creation time (Unix ms).</summary>
    [JsonPropertyName("createdAt")] public long       CreatedAt { get; init; }
    /// <summary>Expiry time (Unix ms).</summary>
    [JsonPropertyName("expiresAt")] public long       ExpiresAt { get; init; }
}

/// <summary>Open friend requests, split by direction.</summary>
public sealed class FriendRequestsResult
{
    /// <summary>Requests received.</summary>
    [JsonPropertyName("incoming")] public FriendRequestInfo[] Incoming { get; init; } = [];
    /// <summary>Requests sent.</summary>
    [JsonPropertyName("outgoing")] public FriendRequestInfo[] Outgoing { get; init; } = [];
}

/// <summary>A friend request was accepted.</summary>
public sealed class FriendRequestAccepted
{
    /// <summary>The friend.</summary>
    [JsonPropertyName("friend")]    public FriendInfo Friend    { get; init; } = new();
    /// <summary>Id of the request.</summary>
    [JsonPropertyName("requestId")] public string?    RequestId { get; init; }
}

/// <summary>A friend request was declined.</summary>
public sealed class FriendRequestDeclined
{
    /// <summary>Id of the request.</summary>
    [JsonPropertyName("requestId")] public string     RequestId { get; init; } = "";
    /// <summary>The user.</summary>
    [JsonPropertyName("user")]      public FriendInfo User      { get; init; } = new();
}

/// <summary>Presence of a friend. Never contains a lobby id.</summary>
public sealed class FriendPresence
{
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]        public string  UserId        { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")]      public string  Username      { get; init; } = "";
    /// <summary>Whether the friend is online.</summary>
    [JsonPropertyName("online")]        public bool    Online        { get; init; }
    /// <summary>Current status.</summary>
    [JsonPropertyName("status")]        public FriendPresenceStatus Status { get; init; } = FriendPresenceStatus.Offline;
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]        public string? GameId        { get; init; }
    /// <summary>Set only when the friend is in a lobby.</summary>
    [JsonPropertyName("lobbyJoinable")] public bool?   LobbyJoinable { get; init; }
    /// <summary>Last time the friend was seen online (Unix ms), if shared.</summary>
    [JsonPropertyName("lastSeen")]      public long?   LastSeen      { get; init; }
}

/// <summary>Own social settings.</summary>
public sealed class SocialSettings
{
    /// <summary>Current status.</summary>
    [JsonPropertyName("status")]                 public OwnPresenceStatus Status        { get; init; } = OwnPresenceStatus.Online;
    /// <summary>Whether friends may see the last-seen time.</summary>
    [JsonPropertyName("showLastSeen")]           public bool     ShowLastSeen           { get; init; } = true;
    /// <summary>Whether read receipts are sent for DMs.</summary>
    [JsonPropertyName("dmReadReceipts")]         public bool     DmReadReceipts         { get; init; } = true;
    /// <summary>Notification types that are not stored or delivered.</summary>
    [JsonPropertyName("mutedNotificationTypes")] public NotificationType[] MutedNotificationTypes { get; init; } = [];
}

/// <summary>A persisted notification.</summary>
public sealed class HubNotification
{
    /// <summary>Unique id.</summary>
    [JsonPropertyName("id")]        public string      Id        { get; init; } = "";
    /// <summary>Message type.</summary>
    [JsonPropertyName("type")]      public NotificationType Type     { get; init; }
    /// <summary>Message payload.</summary>
    [JsonPropertyName("payload")]   public JsonElement Payload   { get; init; }
    /// <summary>Creation time (Unix ms).</summary>
    [JsonPropertyName("createdAt")] public long        CreatedAt { get; init; }
    /// <summary>Time the item was read (Unix ms), or null.</summary>
    [JsonPropertyName("readAt")]    public long?       ReadAt    { get; init; }
    /// <summary>Expiry time (Unix ms).</summary>
    [JsonPropertyName("expiresAt")] public long        ExpiresAt { get; init; }
}

/// <summary>Unread notification summary sent on connect.</summary>
public sealed class NotificationBacklog
{
    /// <summary>Number of unread items.</summary>
    [JsonPropertyName("unreadCount")] public int                UnreadCount { get; init; }
    /// <summary>Most recent notifications.</summary>
    [JsonPropertyName("latest")]      public HubNotification[]  Latest      { get; init; } = [];
}

/// <summary>Notification counters.</summary>
public sealed class NotificationCounts
{
    /// <summary>Number of unread notifications.</summary>
    [JsonPropertyName("unread")]  public int Unread { get; init; }
    /// <summary>Total number of notifications.</summary>
    [JsonPropertyName("total")]   public int Total  { get; init; }
    /// <summary>Counts per notification type (wire value).</summary>
    [JsonPropertyName("byType")]  public Dictionary<string, int> ByType { get; init; } = new();
}

/// <summary>One page of notifications.</summary>
public sealed class NotificationListResult
{
    /// <summary>The notifications.</summary>
    [JsonPropertyName("notifications")] public HubNotification[] Notifications { get; init; } = [];
    /// <summary>Cursor for the next page; null at the end.</summary>
    [JsonPropertyName("nextCursor")]    public string?           NextCursor    { get; init; }
}

/// <summary>Result of marking notifications read.</summary>
public sealed class NotificationMarkResult
{
    /// <summary>Number of notifications marked read.</summary>
    [JsonPropertyName("marked")] public int Marked { get; init; }
    /// <summary>Number of unread notifications.</summary>
    [JsonPropertyName("unread")] public int Unread { get; init; }
}

/// <summary>A direct message between two friends.</summary>
public sealed class DirectMessage
{
    /// <summary>Unique id.</summary>
    [JsonPropertyName("id")]             public string Id             { get; init; } = "";
    /// <summary>Monotonic cursor number (use as <c>before</c> for history paging).</summary>
    [JsonPropertyName("seq")]            public long   Seq            { get; init; }
    /// <summary>Id of the DM conversation.</summary>
    [JsonPropertyName("conversationId")] public string ConversationId { get; init; } = "";
    /// <summary>User id of the sender.</summary>
    [JsonPropertyName("from")]           public string From           { get; init; } = "";
    /// <summary>User id of the recipient.</summary>
    [JsonPropertyName("to")]             public string To             { get; init; } = "";
    /// <summary>Message text.</summary>
    [JsonPropertyName("text")]           public string Text           { get; init; } = "";
    /// <summary>Send time (Unix ms).</summary>
    [JsonPropertyName("sentAt")]         public long   SentAt         { get; init; }
    /// <summary>Delivery time (Unix ms), or null if not yet delivered.</summary>
    [JsonPropertyName("deliveredAt")]    public long?  DeliveredAt    { get; init; }
    /// <summary>Time the item was read (Unix ms), or null.</summary>
    [JsonPropertyName("readAt")]         public long?  ReadAt         { get; init; }
}

/// <summary>Summary of one DM conversation.</summary>
public sealed class DmConversation
{
    /// <summary>User id of the conversation partner.</summary>
    [JsonPropertyName("withUserId")]  public string        WithUserId  { get; init; } = "";
    /// <summary>Display name of the user.</summary>
    [JsonPropertyName("username")]    public string        Username    { get; init; } = "";
    /// <summary>Most recent message in the conversation.</summary>
    [JsonPropertyName("lastMessage")] public DirectMessage LastMessage { get; init; } = new();
    /// <summary>Number of unread items.</summary>
    [JsonPropertyName("unreadCount")] public int           UnreadCount { get; init; }
}

/// <summary>One page of DM history.</summary>
public sealed class DmHistoryResult
{
    /// <summary>The messages, newest first.</summary>
    [JsonPropertyName("messages")]   public DirectMessage[] Messages   { get; init; } = [];
    /// <summary>Pass as <c>before</c> to load the next older page; null when there is no more.</summary>
    [JsonPropertyName("nextBefore")] public long?           NextBefore { get; init; }
}

/// <summary>Messages were delivered to the recipient.</summary>
public sealed class DmDeliveredData
{
    /// <summary>User id that caused the event.</summary>
    [JsonPropertyName("byUserId")]   public string   ByUserId   { get; init; } = "";
    /// <summary>Ids of the affected messages.</summary>
    [JsonPropertyName("messageIds")] public string[] MessageIds { get; init; } = [];
}

/// <summary>Messages were read by the recipient.</summary>
public sealed class DmReadData
{
    /// <summary>User id that caused the event.</summary>
    [JsonPropertyName("byUserId")] public string ByUserId { get; init; } = "";
    /// <summary>All messages up to this sequence number were read.</summary>
    [JsonPropertyName("upToSeq")]  public long   UpToSeq  { get; init; }
}

/// <summary>A friend is typing.</summary>
public sealed class DmTypingData
{
    /// <summary>User id of the sender.</summary>
    [JsonPropertyName("fromUserId")] public string FromUserId { get; init; } = "";
}

/// <summary>An invite to a lobby from a friend.</summary>
public sealed class LobbyInvite
{
    /// <summary>Id of the invite.</summary>
    [JsonPropertyName("inviteId")]     public string InviteId     { get; init; } = "";
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]      public string LobbyId      { get; init; } = "";
    /// <summary>Name of the lobby.</summary>
    [JsonPropertyName("lobbyName")]    public string LobbyName    { get; init; } = "";
    /// <summary>Id of the game.</summary>
    [JsonPropertyName("gameId")]       public string GameId       { get; init; } = "";
    /// <summary>User id of the sender.</summary>
    [JsonPropertyName("fromUserId")]   public string FromUserId   { get; init; } = "";
    /// <summary>Name of the inviting user.</summary>
    [JsonPropertyName("fromUsername")] public string FromUsername { get; init; } = "";
    /// <summary>Expiry time (Unix ms).</summary>
    [JsonPropertyName("expiresAt")]    public long   ExpiresAt    { get; init; }
}

/// <summary>A lobby invite was cancelled.</summary>
public sealed class LobbyInviteCancelledData
{
    /// <summary>Id of the invite.</summary>
    [JsonPropertyName("inviteId")] public string InviteId { get; init; } = "";
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]  public string LobbyId  { get; init; } = "";
    /// <summary>Why this happened.</summary>
    [JsonPropertyName("reason")]   public LobbyInviteCancelReason Reason { get; init; }
}

/// <summary>A lobby invite was declined.</summary>
public sealed class LobbyInviteDeclinedData
{
    /// <summary>Id of the invite.</summary>
    [JsonPropertyName("inviteId")] public string InviteId { get; init; } = "";
    /// <summary>Id of the user.</summary>
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
}

/// <summary>What a friend's lobby looks like to a friend. LobbyId is null for private lobbies.</summary>
public sealed class FriendLobbyInfo
{
    /// <summary>Id of the lobby.</summary>
    [JsonPropertyName("lobbyId")]   public string? LobbyId   { get; init; }
    /// <summary>Display name.</summary>
    [JsonPropertyName("name")]      public string  Name      { get; init; } = "";
    /// <summary>Players currently in the lobby.</summary>
    [JsonPropertyName("players")]   public int     Players   { get; init; }
    /// <summary>Total number of slots.</summary>
    [JsonPropertyName("slots")]     public int     Slots     { get; init; }
    /// <summary>Whether the lobby can currently be joined.</summary>
    [JsonPropertyName("joinable")]  public bool    Joinable  { get; init; }
    /// <summary>Whether joining requires host approval.</summary>
    [JsonPropertyName("locked")]    public bool    Locked    { get; init; }
    /// <summary>Whether the caller holds an invite for this lobby.</summary>
    [JsonPropertyName("hasInvite")] public bool    HasInvite { get; init; }
}

/// <summary>Result of <c>JoinFriendAsync</c>: pending = a join request was sent to the host.</summary>
public sealed class JoinFriendResult
{
    /// <summary>True when a join request was sent to the host instead of joining directly.</summary>
    [JsonPropertyName("pending")] public bool   Pending { get; init; }
    /// <summary>The lobby.</summary>
    [JsonPropertyName("lobby")]   public Lobby? Lobby   { get; init; }
}

/// <summary>Unread count of one conversation.</summary>
public sealed class DmConversationUnread
{
    /// <summary>User id of the conversation partner.</summary>
    [JsonPropertyName("withUserId")]  public string WithUserId  { get; init; } = "";
    /// <summary>Number of unread items.</summary>
    [JsonPropertyName("unreadCount")] public int    UnreadCount { get; init; }
}

/// <summary>Full social state, or a not-modified marker.</summary>
public sealed class SocialSnapshot
{
    /// <summary>True when the supplied etag is still current; all other fields are empty then.</summary>
    [JsonPropertyName("notModified")]         public bool                   NotModified         { get; init; }
    /// <summary>Opaque version tag; pass it to the next SyncSocialAsync call.</summary>
    [JsonPropertyName("etag")]                public string                 Etag                { get; init; } = "";
    /// <summary>Hub time (Unix ms).</summary>
    [JsonPropertyName("serverTime")]          public long                   ServerTime          { get; init; }
    /// <summary>Current status.</summary>
    [JsonPropertyName("status")]              public OwnPresenceStatus      Status              { get; init; } = OwnPresenceStatus.Online;
    /// <summary>Free-form lobby settings.</summary>
    [JsonPropertyName("settings")]            public SocialSettings         Settings            { get; init; } = new();
    /// <summary>All friends.</summary>
    [JsonPropertyName("friends")]             public FriendInfo[]           Friends             { get; init; } = [];
    /// <summary>Presence of all friends.</summary>
    [JsonPropertyName("presence")]            public FriendPresence[]       Presence            { get; init; } = [];
    /// <summary>Open friend requests.</summary>
    [JsonPropertyName("requests")]            public FriendRequestsResult   Requests            { get; init; } = new();
    /// <summary>Open lobby invites.</summary>
    [JsonPropertyName("lobbyInvites")]        public LobbyInvite[]          LobbyInvites        { get; init; } = [];
    /// <summary>Number of unread notifications.</summary>
    [JsonPropertyName("unreadNotifications")] public int                    UnreadNotifications { get; init; }
    /// <summary>Unread counts per conversation.</summary>
    [JsonPropertyName("conversations")]       public DmConversationUnread[] Conversations       { get; init; } = [];
}
