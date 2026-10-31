using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

public sealed class FriendInfo
{
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
    [JsonPropertyName("username")] public string Username { get; init; } = "";
}

public sealed class FriendRequestInfo
{
    [JsonPropertyName("id")]        public string     Id        { get; init; } = "";
    /// <summary>Sender for incoming requests, recipient for outgoing ones.</summary>
    [JsonPropertyName("user")]      public FriendInfo User      { get; init; } = new();
    /// <summary>"name" or "lobby".</summary>
    [JsonPropertyName("source")]    public string     Source    { get; init; } = "";
    [JsonPropertyName("createdAt")] public long       CreatedAt { get; init; }
    [JsonPropertyName("expiresAt")] public long       ExpiresAt { get; init; }
}

public sealed class FriendRequestsResult
{
    [JsonPropertyName("incoming")] public FriendRequestInfo[] Incoming { get; init; } = [];
    [JsonPropertyName("outgoing")] public FriendRequestInfo[] Outgoing { get; init; } = [];
}

public sealed class FriendRequestAccepted
{
    [JsonPropertyName("friend")]    public FriendInfo Friend    { get; init; } = new();
    [JsonPropertyName("requestId")] public string?    RequestId { get; init; }
}

public sealed class FriendRequestDeclined
{
    [JsonPropertyName("requestId")] public string     RequestId { get; init; } = "";
    [JsonPropertyName("user")]      public FriendInfo User      { get; init; } = new();
}

/// <summary>Presence of a friend. Never contains a lobby id.</summary>
public sealed class FriendPresence
{
    [JsonPropertyName("userId")]        public string  UserId        { get; init; } = "";
    [JsonPropertyName("username")]      public string  Username      { get; init; } = "";
    [JsonPropertyName("online")]        public bool    Online        { get; init; }
    /// <summary>"online" | "away" | "busy" | "offline".</summary>
    [JsonPropertyName("status")]        public string  Status        { get; init; } = "offline";
    [JsonPropertyName("gameId")]        public string? GameId        { get; init; }
    /// <summary>Set only when the friend is in a lobby.</summary>
    [JsonPropertyName("lobbyJoinable")] public bool?   LobbyJoinable { get; init; }
    [JsonPropertyName("lastSeen")]      public long?   LastSeen      { get; init; }
}

public sealed class SocialSettings
{
    /// <summary>"online" | "away" | "busy" | "invisible".</summary>
    [JsonPropertyName("status")]                 public string   Status                 { get; init; } = "online";
    [JsonPropertyName("showLastSeen")]           public bool     ShowLastSeen           { get; init; } = true;
    [JsonPropertyName("dmReadReceipts")]         public bool     DmReadReceipts         { get; init; } = true;
    [JsonPropertyName("mutedNotificationTypes")] public string[] MutedNotificationTypes { get; init; } = [];
}

public sealed class HubNotification
{
    [JsonPropertyName("id")]        public string      Id        { get; init; } = "";
    [JsonPropertyName("type")]      public string      Type      { get; init; } = "";
    [JsonPropertyName("payload")]   public JsonElement Payload   { get; init; }
    [JsonPropertyName("createdAt")] public long        CreatedAt { get; init; }
    [JsonPropertyName("readAt")]    public long?       ReadAt    { get; init; }
    [JsonPropertyName("expiresAt")] public long        ExpiresAt { get; init; }
}

public sealed class NotificationBacklog
{
    [JsonPropertyName("unreadCount")] public int                UnreadCount { get; init; }
    [JsonPropertyName("latest")]      public HubNotification[]  Latest      { get; init; } = [];
}

public sealed class NotificationCounts
{
    [JsonPropertyName("unread")]  public int Unread { get; init; }
    [JsonPropertyName("total")]   public int Total  { get; init; }
    [JsonPropertyName("byType")]  public Dictionary<string, int> ByType { get; init; } = new();
}

public sealed class NotificationListResult
{
    [JsonPropertyName("notifications")] public HubNotification[] Notifications { get; init; } = [];
    [JsonPropertyName("nextCursor")]    public string?           NextCursor    { get; init; }
}

public sealed class NotificationMarkResult
{
    [JsonPropertyName("marked")] public int Marked { get; init; }
    [JsonPropertyName("unread")] public int Unread { get; init; }
}

public sealed class DirectMessage
{
    [JsonPropertyName("id")]             public string Id             { get; init; } = "";
    /// <summary>Monotonic cursor number (use as <c>before</c> for history paging).</summary>
    [JsonPropertyName("seq")]            public long   Seq            { get; init; }
    [JsonPropertyName("conversationId")] public string ConversationId { get; init; } = "";
    [JsonPropertyName("from")]           public string From           { get; init; } = "";
    [JsonPropertyName("to")]             public string To             { get; init; } = "";
    [JsonPropertyName("text")]           public string Text           { get; init; } = "";
    [JsonPropertyName("sentAt")]         public long   SentAt         { get; init; }
    [JsonPropertyName("deliveredAt")]    public long?  DeliveredAt    { get; init; }
    [JsonPropertyName("readAt")]         public long?  ReadAt         { get; init; }
}

public sealed class DmConversation
{
    [JsonPropertyName("withUserId")]  public string        WithUserId  { get; init; } = "";
    [JsonPropertyName("username")]    public string        Username    { get; init; } = "";
    [JsonPropertyName("lastMessage")] public DirectMessage LastMessage { get; init; } = new();
    [JsonPropertyName("unreadCount")] public int           UnreadCount { get; init; }
}

public sealed class DmHistoryResult
{
    [JsonPropertyName("messages")]   public DirectMessage[] Messages   { get; init; } = [];
    /// <summary>Pass as <c>before</c> to load the next older page; null when there is no more.</summary>
    [JsonPropertyName("nextBefore")] public long?           NextBefore { get; init; }
}

public sealed class DmDeliveredData
{
    [JsonPropertyName("byUserId")]   public string   ByUserId   { get; init; } = "";
    [JsonPropertyName("messageIds")] public string[] MessageIds { get; init; } = [];
}

public sealed class DmReadData
{
    [JsonPropertyName("byUserId")] public string ByUserId { get; init; } = "";
    [JsonPropertyName("upToSeq")]  public long   UpToSeq  { get; init; }
}

public sealed class DmTypingData
{
    [JsonPropertyName("fromUserId")] public string FromUserId { get; init; } = "";
}

public sealed class LobbyInvite
{
    [JsonPropertyName("inviteId")]     public string InviteId     { get; init; } = "";
    [JsonPropertyName("lobbyId")]      public string LobbyId      { get; init; } = "";
    [JsonPropertyName("lobbyName")]    public string LobbyName    { get; init; } = "";
    [JsonPropertyName("gameId")]       public string GameId       { get; init; } = "";
    [JsonPropertyName("fromUserId")]   public string FromUserId   { get; init; } = "";
    [JsonPropertyName("fromUsername")] public string FromUsername { get; init; } = "";
    [JsonPropertyName("expiresAt")]    public long   ExpiresAt    { get; init; }
}

public sealed class LobbyInviteCancelledData
{
    [JsonPropertyName("inviteId")] public string InviteId { get; init; } = "";
    [JsonPropertyName("lobbyId")]  public string LobbyId  { get; init; } = "";
    /// <summary>cancelled | expired | lobby_closed | lobby_full | left | unfriended.</summary>
    [JsonPropertyName("reason")]   public string Reason   { get; init; } = "";
}

public sealed class LobbyInviteDeclinedData
{
    [JsonPropertyName("inviteId")] public string InviteId { get; init; } = "";
    [JsonPropertyName("userId")]   public string UserId   { get; init; } = "";
}

/// <summary>What a friend's lobby looks like to a friend. LobbyId is null for private lobbies.</summary>
public sealed class FriendLobbyInfo
{
    [JsonPropertyName("lobbyId")]   public string? LobbyId   { get; init; }
    [JsonPropertyName("name")]      public string  Name      { get; init; } = "";
    [JsonPropertyName("players")]   public int     Players   { get; init; }
    [JsonPropertyName("slots")]     public int     Slots     { get; init; }
    [JsonPropertyName("joinable")]  public bool    Joinable  { get; init; }
    [JsonPropertyName("locked")]    public bool    Locked    { get; init; }
    [JsonPropertyName("hasInvite")] public bool    HasInvite { get; init; }
}

/// <summary>Result of <c>JoinFriendAsync</c>: pending = a join request was sent to the host.</summary>
public sealed class JoinFriendResult
{
    [JsonPropertyName("pending")] public bool   Pending { get; init; }
    [JsonPropertyName("lobby")]   public Lobby? Lobby   { get; init; }
}

public sealed class DmConversationUnread
{
    [JsonPropertyName("withUserId")]  public string WithUserId  { get; init; } = "";
    [JsonPropertyName("unreadCount")] public int    UnreadCount { get; init; }
}

public sealed class SocialSnapshot
{
    /// <summary>True when the supplied etag is still current; all other fields are empty then.</summary>
    [JsonPropertyName("notModified")]         public bool                   NotModified         { get; init; }
    [JsonPropertyName("etag")]                public string                 Etag                { get; init; } = "";
    [JsonPropertyName("serverTime")]          public long                   ServerTime          { get; init; }
    [JsonPropertyName("status")]              public string                 Status              { get; init; } = "online";
    [JsonPropertyName("settings")]            public SocialSettings         Settings            { get; init; } = new();
    [JsonPropertyName("friends")]             public FriendInfo[]           Friends             { get; init; } = [];
    [JsonPropertyName("presence")]            public FriendPresence[]       Presence            { get; init; } = [];
    [JsonPropertyName("requests")]            public FriendRequestsResult   Requests            { get; init; } = new();
    [JsonPropertyName("lobbyInvites")]        public LobbyInvite[]          LobbyInvites        { get; init; } = [];
    [JsonPropertyName("unreadNotifications")] public int                    UnreadNotifications { get; init; }
    [JsonPropertyName("conversations")]       public DmConversationUnread[] Conversations       { get; init; } = [];
}
