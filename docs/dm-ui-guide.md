# DM / unread state: what a UI needs

How a friends panel or in-game social UI should use the hub's DM API. Every call exists in both ODKs (see [sdk-nodejs.md](sdk-nodejs.md), [sdk-csharp.md](sdk-csharp.md)). Protocol details: [social-api.md](social-api.md).

## Data model

- Messages are stored with a global ascending `seq`, `sentAt`, `deliveredAt?`, `readAt?`, for `DM_RETENTION_DAYS` (30).
- Per chat the hub derives a **read cursor** `lastReadSeq` (highest incoming message read). Unread = incoming messages with `seq > lastReadSeq`.
- The sender can see how far the friend has read via `peerLastReadSeq` (hidden when the friend disabled read receipts).

## UI flows

| UI element | Source | Update trigger |
|---|---|---|
| Unread dot / count next to a friend | `social:sync.conversations` or `dm:unread` (`unreadCount` per `withUserId`) | `dm:received` (+1 locally), `dm:readState` (replace with `unreadCount`) |
| App/tab badge | `dm:unread.totalUnread` / `DmReadState.totalUnread` | `dm:received`, `dm:readState` |
| Sort friends by recent chat | `lastSeq` / `lastMessageAt` in `dm:unread`, `dm:conversations[].lastMessage` | `dm:received` |
| Toast for a message while the panel is closed | `dm:received`; offline: `notification` / `notification:backlog` with type `dm` (collapsed per chat, payload has `count`, `preview`) | — |
| Open a chat | `dm:open` → last 10 messages, `firstUnreadSeq` for a "new messages" divider, `unreadCount` before opening | server marks read, `dm:readState` follows |
| Scroll up | `dm:history { before: nextBefore }` | — |
| "Seen" tick under own message | `peerLastReadSeq` from `dm:open`/`dm:history`; live via `dm:read.upToSeq` | `dm:read` |
| Delivered tick | `deliveredAt`; live `dm:delivered { messageIds }` | `dm:delivered` |
| Typing indicator | `dm:typing` (throttle the sender, hide after ~5 s) | `dm:typing` |
| Chat stays open while a message arrives | on `dm:received` for the open chat call `dm:markRead { upToSeq: message.seq }` | `dm:readState` |
| Partially visible chat | `dm:markRead { upToSeq }` with the last visible `seq` | — |
| Several devices | all sessions receive `dm:readState`, so a read on the phone clears the PC badge | `dm:readState` |

## Rules of thumb

1. Start: `social:sync` (one call) → friend list with presence and unread counts. Then rely on events; re-sync after a reconnect.
2. Opening a chat is one call (`dm:open`); never mark messages read just because they were *received*, only when shown.
3. `firstUnreadSeq` may be older than the page returned by `dm:open` (more than 10 unread): load older pages with `dm:history` until you reach it, or show "N unread above".
4. Removing a friend deletes the chat for both sides; expect `NOT_FRIENDS` afterwards.
5. Messages older than the retention disappear; the unread count never includes them.
