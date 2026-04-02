# Client Integration Guide

Complete integration spec for Android & iOS clients connecting to the Cloudflare Chat Server.
All communication uses JSON over HTTPS (REST) and WSS (WebSocket). Both platforms follow identical flows.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Base URL & Headers](#2-base-url--headers)
3. [REST API Reference](#3-rest-api-reference)
4. [WebSocket: Chat](#4-websocket-chat)
5. [WebSocket: Chat Message Reference](#5-websocket-chat-message-reference)
6. [Push Notifications](#6-push-notifications)
7. [Voice & Video Calling](#7-voice--video-calling)
8. [WebSocket: Call Signaling Message Reference](#8-websocket-call-signaling-message-reference)
9. [Error Codes](#9-error-codes)
10. [Rate Limits](#10-rate-limits)
11. [Constraints & Validation](#11-constraints--validation)
12. [Recommended Client Behavior](#12-recommended-client-behavior)

---

## 1. Authentication

Every request (REST and WebSocket) must include a JWT token.

**JWT format**: HMAC-SHA256 (`HS256`) signed with the server's `AUTH_SECRET`.

**Required JWT payload fields** (at minimum):
```json
{
  "userId": "user_abc123",
  "exp": 1735689600,
  "iat": 1735603200
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | string | Yes | Unique user identifier (alternative: use `sub` claim) |
| `sub` | string | Alternative | Used as userId if `userId` field is absent |
| `exp` | number | Recommended | Expiration time (unix seconds). Server rejects expired tokens |
| `iat` | number | Optional | Issued-at time. Server rejects tokens issued more than 60s in the future |

**How to pass the token:**

| Method | Location | Format |
|--------|----------|--------|
| REST API | `Authorization` header | `Bearer <jwt>` |
| REST API | Query param (fallback) | `?token=<jwt>` |
| WebSocket | Query param | `?token=<jwt>` |

**Dev mode**: If the server has no `AUTH_SECRET` configured, it accepts any string as token and uses it directly as `userId`. Do NOT rely on this in production.

---

## 2. Base URL & Headers

```
Base URL: https://your-worker.your-subdomain.workers.dev
```

**Required headers for REST:**
```
Content-Type: application/json
Authorization: Bearer <jwt>
```

**All responses** are `application/json`.

---

## 3. REST API Reference

### 3.1 Health Check

```
GET /health
```

No authentication required.

**Response** `200`:
```json
{ "status": "ok" }
```

---

### 3.2 Create Conversation

```
POST /conversations
```

Creates a 1:1 DM or group chat. The authenticated user is automatically included as a member.

**Request body:**
```json
{
  "userIds": ["user_bob", "user_charlie"],
  "type": "group",
  "name": "Team Chat",
  "participants": [
    { "userId": "user_bob", "name": "Bob", "email": "bob@example.com", "image": "https://..." },
    { "userId": "user_charlie", "name": "Charlie" }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userIds` | string[] | Yes | Other user IDs to include (must be non-empty strings) |
| `type` | `"group"` | No | Omit or set to anything else for DM. Set `"group"` for group chat |
| `name` | string | No | Group name (only used when `type` is `"group"`) |
| `participants` | object[] | No | Rich participant metadata stored for display |

**Conversation ID generation rules:**
- **DM**: `dm_{sorted_user_ids_joined_by_underscore}` (e.g., `dm_alice_bob`) — deterministic, so creating the same DM twice returns the same conversation
- **Group**: `group_{random_uuid}` — always unique

**Response** `200`:
```json
{
  "conversationId": "dm_alice_bob",
  "createdAt": 1710000000000
}
```

**Roles**: The creator gets `admin` role. All others get `member` role.

---

### 3.3 Get Message History

```
GET /conversations/{conversationId}/history?before={timestamp}&limit={number}
```

Returns messages in chronological order (oldest first). Only members can access.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `before` | number | No | - | Unix ms timestamp. Only return messages created before this |
| `limit` | number | No | 50 | Max messages to return (capped at 100) |

**Response** `200`:
```json
{
  "messages": [
    {
      "type": "message",
      "id": "msg_1710000000000_a1b2c3d4",
      "senderId": "user_alice",
      "content": "Hello!",
      "messageType": "text",
      "createdAt": 1710000000000,
      "editedAt": null,
      "metadata": { "customKey": "customValue" }
    }
  ],
  "lastReadIndex": 1710000000000
}
```

**Pagination**: To load older messages, pass `before` = `createdAt` of the oldest message you have.

---

### 3.4 List My Conversations

```
GET /users/{userId}/conversations
```

Returns all conversations for the authenticated user. **You can only query your own userId** — the server rejects requests where the path userId doesn't match the JWT userId.

**Response** `200`:
```json
{
  "conversations": [
    {
      "conversationId": "dm_alice_bob",
      "type": "dm",
      "name": null,
      "userIds": ["user_alice", "user_bob"],
      "participants": [
        { "userId": "user_alice", "name": "Alice", "email": "alice@example.com", "image": "https://..." },
        { "userId": "user_bob", "name": "Bob" }
      ],
      "createdAt": 1710000000000,
      "unreadCount": 3,
      "lastUnreadMessage": {
        "type": "message",
        "id": "msg_1710000000000_a1b2c3d4",
        "senderId": "user_bob",
        "content": "Hey, are you there?",
        "messageType": "text",
        "createdAt": 1710000000500,
        "editedAt": null,
        "metadata": null
      }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `unreadCount` | number | Number of unread messages for the authenticated user |
| `lastUnreadMessage` | object \| null | The most recent unread message (or `null` if none). Same shape as message in history/sync. |

---

### 3.5 Get User Presence

```
GET /users/{userId}/presence
```

Any authenticated user can check any other user's presence.

**Response** `200`:
```json
{
  "status": "online",
  "lastSeen": 1710000000000,
  "activeConversations": 2
}
```

| Field | Type | Values |
|-------|------|--------|
| `status` | string | `"online"`, `"offline"`, `"away"` |
| `lastSeen` | number | Unix ms of last activity |
| `activeConversations` | number | Count of active WebSocket connections |

**Presence rules:**
- User goes `online` when they connect a chat WebSocket
- User goes `offline` when ALL their chat WebSocket connections are closed
- User auto-goes `offline` after 15 minutes of no WebSocket activity

---

### 3.6 Group Management

#### List Members

```
GET /conversations/{conversationId}/members
```

**Response** `200`:
```json
{
  "members": [
    { "userId": "user_alice", "role": "admin", "joinedAt": 1710000000000 },
    { "userId": "user_bob", "role": "member", "joinedAt": 1710000000000 }
  ]
}
```

#### Add Members (admin only)

```
POST /conversations/{conversationId}/members
```

**Request body:**
```json
{
  "userIds": ["user_dave", "user_eve"],
  "participants": [
    { "userId": "user_dave", "name": "Dave" },
    { "userId": "user_eve", "name": "Eve" }
  ]
}
```

**Response** `200`:
```json
{ "ok": true, "added": ["user_dave", "user_eve"] }
```

- Only works on group conversations (not DMs)
- Only admins can add members
- Already-existing members are silently skipped
- Connected clients receive a `member_added` WebSocket event

#### Remove Members (admin only)

```
POST /conversations/{conversationId}/members/remove
```

**Request body:**
```json
{ "userIds": ["user_dave"] }
```

**Response** `200`:
```json
{ "ok": true, "removed": ["user_dave"] }
```

- Admins cannot remove themselves (use `/leave` instead)
- Removed user's WebSocket is closed with code `4003`
- Connected clients receive a `member_removed` WebSocket event

#### Leave Group

```
POST /conversations/{conversationId}/leave
```

No request body needed.

**Response** `200`:
```json
{ "ok": true }
```

- Cannot leave a DM (only groups)
- Your WebSocket is closed with code `4004`
- Connected clients receive a `member_removed` event (where `userId` == `removedBy`)

#### Update Group Name (admin only)

```
PUT /conversations/{conversationId}
```

**Request body:**
```json
{ "name": "New Group Name" }
```

**Response** `200`:
```json
{ "ok": true }
```

---

### 3.7 Push Device Registration

#### Register Device

```
POST /devices
```

**Request body:**
```json
{
  "platform": "android",
  "token": "fcm_device_token_here",
  "appId": "com.yourapp.chat"
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `platform` | string | Yes | `"android"` or `"ios"` |
| `token` | string | Yes | FCM token (Android) or APNs device token (iOS) |
| `appId` | string | No | Your app's bundle identifier |

**Response** `200`:
```json
{ "ok": true, "deviceCount": 2 }
```

- Max 5 devices per user. Oldest device is dropped when limit is exceeded.
- Re-registering the same token updates its timestamp.

#### Unregister Device

```
POST /devices/unregister
```

**Request body:**
```json
{ "token": "fcm_device_token_here" }
```

**Response** `200`:
```json
{ "ok": true }
```

Call this on **logout** to stop receiving push notifications.

---

## 4. WebSocket: Chat

### Connection

```
wss://your-worker/ws?conversationId={conversationId}&token={jwt}
```

| Param | Required | Description |
|-------|----------|-------------|
| `conversationId` | Yes | The conversation to join |
| `token` | Yes | Your JWT |

**Connection requirements:**
- You must be a member of the conversation (server returns `403` otherwise)
- Standard WebSocket upgrade headers required

### On Connect

The server immediately sends a **sync** message with the last 50 messages and your read position:

```json
{
  "type": "sync",
  "messages": [
    {
      "type": "message",
      "id": "msg_1710000000000_a1b2c3d4",
      "senderId": "user_alice",
      "content": "Hello!",
      "messageType": "text",
      "createdAt": 1710000000000,
      "editedAt": null,
      "metadata": null
    }
  ],
  "lastReadIndex": 1710000000000
}
```

Use `lastReadIndex` to determine which messages are unread. Messages with `createdAt > lastReadIndex` are unread.

### Keepalive

The server responds to the literal string `"ping"` with `"pong"` automatically (WebSocket auto-response). You can also send a JSON ping:

```json
{ "type": "ping" }
```

Server responds with:
```json
{ "type": "pong" }
```

### Disconnection

When your WebSocket closes:
- Your typing indicator is automatically cleared
- Your presence is updated (marked offline if this was your last active connection)

---

## 5. WebSocket Chat Message Reference

### Client -> Server Messages

#### Send Text Message

```json
{
  "type": "text",
  "content": "Hello world!",
  "tempId": "client-uuid-123",
  "metadata": { "replyTo": "msg_123" }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `content` | string | Yes | 1–4096 characters, non-empty after trim |
| `tempId` | string | No | Client-generated UUID for delivery tracking |
| `metadata` | object | No | Max 2048 bytes when serialized as JSON |

**Server responds with `message_ack` (to sender only) then broadcasts `message` (to all).**

#### Edit Message

```json
{
  "type": "edit",
  "messageId": "msg_1710000000000_a1b2c3d4",
  "newContent": "Updated text"
}
```

- Only the original sender can edit their message
- Cannot edit deleted messages
- Same content constraints as send (1–4096 chars)

#### Delete Message

```json
{
  "type": "delete",
  "messageId": "msg_1710000000000_a1b2c3d4"
}
```

- Only the original sender can delete their message
- Soft delete (server sets `deleted_at`, message excluded from future queries)

#### Typing Indicator

```json
{ "type": "typing" }
```

- Server broadcasts `typing` to all OTHER connected clients
- Server automatically sends `typing_stopped` after **5 seconds** of no typing events
- Typing is also auto-cleared when you send a message or disconnect
- **Client should debounce**: send at most once every 2–3 seconds

#### Mark Read

```json
{
  "type": "mark_read",
  "lastReadIndex": 1710000050000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `lastReadIndex` | number | Timestamp of the latest message you've read. Must be a finite number |

- Broadcasts `read_receipt` to all connected clients

#### Ping

```json
{ "type": "ping" }
```

Server responds with `{ "type": "pong" }`.

---

### Server -> Client Messages

#### sync

Sent immediately on WebSocket connect.

```json
{
  "type": "sync",
  "messages": [ /* array of message objects */ ],
  "lastReadIndex": 1710000000000
}
```

#### message

Broadcast to ALL connected clients when a new message is sent.

```json
{
  "type": "message",
  "id": "msg_1710000000000_a1b2c3d4",
  "senderId": "user_alice",
  "content": "Hello!",
  "messageType": "text",
  "createdAt": 1710000000000,
  "tempId": "client-uuid-123",
  "metadata": { "replyTo": "msg_123" }
}
```

#### message_ack

Sent to the **sender only** after their message is stored.

```json
{
  "type": "message_ack",
  "id": "msg_1710000000000_a1b2c3d4",
  "tempId": "client-uuid-123",
  "createdAt": 1710000000000
}
```

**Match `tempId`** to your locally-generated ID to confirm delivery. Replace your optimistic message with the confirmed `id`.

#### message_edited

Broadcast to all when a message is edited.

```json
{
  "type": "message_edited",
  "messageId": "msg_1710000000000_a1b2c3d4",
  "newContent": "Updated text",
  "editedAt": 1710000060000
}
```

#### message_deleted

Broadcast to all when a message is deleted.

```json
{
  "type": "message_deleted",
  "messageId": "msg_1710000000000_a1b2c3d4"
}
```

#### read_receipt

Broadcast to all when someone marks messages as read.

```json
{
  "type": "read_receipt",
  "userId": "user_bob",
  "lastReadIndex": 1710000050000,
  "lastReadAt": 1710000060000
}
```

#### typing

Broadcast to all EXCEPT the sender.

```json
{
  "type": "typing",
  "userId": "user_bob"
}
```

#### typing_stopped

Broadcast when typing auto-expires (5s) or user sends a message / disconnects.

```json
{
  "type": "typing_stopped",
  "userId": "user_bob"
}
```

#### member_added

Broadcast when a member is added to the group.

```json
{
  "type": "member_added",
  "userId": "user_dave",
  "addedBy": "user_alice"
}
```

#### member_removed

Broadcast when a member is removed or leaves.

```json
{
  "type": "member_removed",
  "userId": "user_dave",
  "removedBy": "user_alice"
}
```

When `userId == removedBy`, the user left voluntarily. If this is YOUR userId, close the chat screen.

#### error

Sent to the sender only when a message fails validation or processing.

```json
{
  "type": "error",
  "code": "RATE_LIMITED",
  "message": "Too many messages, slow down"
}
```

#### pong

Response to `{ "type": "ping" }`.

```json
{ "type": "pong" }
```

---

## 6. Push Notifications

### Setup (Android)

1. Integrate Firebase Cloud Messaging (FCM) in your app
2. On token refresh: `POST /devices` with `{ "platform": "android", "token": "<fcm_token>" }`
3. On logout: `POST /devices/unregister` with `{ "token": "<fcm_token>" }`

### Setup (iOS)

1. Request notification permission via `UNUserNotificationCenter`
2. Register for remote notifications to get APNs device token
3. On token received: `POST /devices` with `{ "platform": "ios", "token": "<apns_hex_token>" }`
4. On logout: `POST /devices/unregister` with `{ "token": "<apns_hex_token>" }`

### Push Payload Format

The server sends pushes in this format:

**FCM (Android) notification payload:**
```json
{
  "to": "<device_token>",
  "notification": {
    "title": "New message",
    "body": "Hello! This is a preview..."
  },
  "data": {
    "conversationId": "dm_alice_bob",
    "senderId": "user_alice"
  },
  "priority": "high"
}
```

**APNs (iOS) payload:**
```json
{
  "aps": {
    "alert": {
      "title": "New message",
      "body": "Hello! This is a preview..."
    },
    "sound": "default",
    "badge": 1,
    "mutable-content": 1
  },
  "conversationId": "dm_alice_bob",
  "senderId": "user_alice"
}
```

### Push for Incoming Calls

```json
{
  "title": "Incoming Video Call",
  "body": "Call from user_alice",
  "data": {
    "type": "call_incoming",
    "callId": "call_uuid-here",
    "callerId": "user_alice",
    "callType": "video"
  }
}
```

**iOS**: Use this to trigger **CallKit** (`CXProvider.reportNewIncomingCall`).
**Android**: Use this to show a **full-screen notification** and create a `ConnectionService` `Connection`.

### When Pushes Are Sent

- **New message**: Sent to members who do NOT have an active WebSocket in that conversation
- **Incoming call**: Sent to all target users when a call is initiated
- Message body is truncated to 100 characters with `...` suffix

---

## 7. Voice & Video Calling

### 7.1 Initiate a Call

```
POST /calls
```

**Request body:**
```json
{
  "targetUserIds": ["user_bob"],
  "callType": "video"
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `targetUserIds` | string[] | Yes | User IDs to call |
| `callType` | string | Yes | `"voice"` or `"video"` |

**Response** `200`:
```json
{
  "ok": true,
  "callId": "call_a1b2c3d4-e5f6-...",
  "state": "ringing"
}
```

This does three things:
1. Creates call state on server (state = `ringing`)
2. Sends push notification to all target users
3. Sets a **30-second ring timeout** — if nobody answers, call auto-ends

### 7.2 Get Call Status

```
GET /calls/{callId}
```

**Response** `200`:
```json
{
  "callId": "call_a1b2c3d4-e5f6-...",
  "callerId": "user_alice",
  "participants": ["user_alice", "user_bob"],
  "callType": "video",
  "state": "ringing",
  "startedAt": 1710000000000,
  "answeredAt": null,
  "endedAt": null
}
```

| State | Meaning |
|-------|---------|
| `"ringing"` | Call initiated, waiting for answer |
| `"active"` | Call in progress |
| `"ended"` | Call finished |

### 7.3 Get ICE Servers

```
GET /calls/ice-servers
```

**Call this before creating your `RTCPeerConnection`.** Response contains STUN and (if configured) TURN servers.

**Response** `200`:
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    {
      "urls": "turn:turn.example.com:3478",
      "username": "1710086400:cloudflare-chat",
      "credential": "base64-hmac-credential"
    }
  ]
}
```

TURN credentials are time-limited (24 hours).

### 7.4 Call Signaling WebSocket

```
wss://your-worker/ws/call?callId={callId}&token={jwt}
```

On connect, the server sends the current call state:
```json
{
  "type": "call_status",
  "callId": "call_...",
  "callerId": "user_alice",
  "participants": ["user_alice", "user_bob"],
  "callType": "video",
  "state": "ringing",
  "startedAt": 1710000000000
}
```

### 7.5 Complete Call Flow

```
CALLER                                    CALLEE
  |                                         |
  |-- POST /calls ----------------------->  |
  |   { targetUserIds, callType }           |
  |   <- { callId, state: "ringing" }      |
  |                                         |
  |                                         |<-- Push notification arrives
  |                                         |    data.type = "call_incoming"
  |                                         |    data.callId = "call_..."
  |                                         |
  |                                         |    [iOS: Trigger CallKit]
  |                                         |    [Android: Show full-screen notification]
  |                                         |
  |-- Connect WS:                           |-- Connect WS:
  |   /ws/call?callId=...&token=...         |   /ws/call?callId=...&token=...
  |                                         |
  |   <- call_status (ringing)              |   <- call_status (ringing)
  |                                         |
  |                          User taps Accept:
  |                                         |-- Send: { "type": "accept" }
  |                                         |
  |   <- call_accepted                      |   <- call_accepted
  |      { callId, userId }                 |
  |                                         |
  |-- GET /calls/ice-servers                |-- GET /calls/ice-servers
  |   <- { iceServers: [...] }              |   <- { iceServers: [...] }
  |                                         |
  |-- Create RTCPeerConnection              |-- Create RTCPeerConnection
  |   with iceServers                       |   with iceServers
  |                                         |
  |-- createOffer()                         |
  |-- setLocalDescription(offer)            |
  |-- Send WS: {                            |
  |     "type": "offer",                    |
  |     "targetUserId": "user_bob",         |
  |     "payload": <SDP offer>              |
  |   }                                     |
  |                                         |
  |                                         |<-- Receive offer
  |                                         |    { type: "offer",
  |                                         |      fromUserId: "user_alice",
  |                                         |      payload: <SDP> }
  |                                         |
  |                                         |-- setRemoteDescription(offer)
  |                                         |-- createAnswer()
  |                                         |-- setLocalDescription(answer)
  |                                         |-- Send WS: {
  |                                         |     "type": "answer",
  |                                         |     "targetUserId": "user_alice",
  |                                         |     "payload": <SDP answer>
  |                                         |   }
  |                                         |
  |<-- Receive answer                       |
  |    setRemoteDescription(answer)         |
  |                                         |
  |<--------- ICE candidates exchanged -------->|
  |   { "type": "ice-candidate",            |
  |     "targetUserId": "...",              |
  |     "payload": <ICE candidate> }        |
  |                                         |
  |========== Media flowing (P2P) ==========|
  |                                         |
  |   User taps Hangup:                     |
  |-- Send: { "type": "hangup" }            |
  |                                         |
  |   <- call_ended                         |   <- call_ended
  |      { callId, endedBy, reason }        |
  |                                         |
  |   Close PeerConnection                  |   Close PeerConnection
  |   Close WebSocket                       |   Close WebSocket
```

**If callee declines:**
```json
// Callee sends:
{ "type": "reject", "reason": "busy" }

// Both receive:
{ "type": "call_rejected", "callId": "...", "userId": "user_bob", "reason": "busy" }

// For 1:1 calls, this also triggers:
{ "type": "call_ended", "callId": "...", "endedBy": "user_bob", "reason": "declined" }
```

**If nobody answers in 30 seconds:**
```json
// Both receive:
{ "type": "call_ended", "callId": "...", "endedBy": "system", "reason": "timeout" }
```

---

## 8. WebSocket Call Signaling Message Reference

### Client -> Server

| Type | Fields | Description |
|------|--------|-------------|
| `offer` | `targetUserId`, `payload` (SDP) | WebRTC SDP offer |
| `answer` | `targetUserId`, `payload` (SDP) | WebRTC SDP answer |
| `ice-candidate` | `targetUserId`, `payload` (candidate) | ICE candidate |
| `accept` | (none) | Accept the ringing call |
| `reject` | `reason?` (string) | Reject/decline the call |
| `hangup` | (none) | End an active call |

### Server -> Client

| Type | Fields | Description |
|------|--------|-------------|
| `call_status` | Full call metadata | Sent on WS connect |
| `call_incoming` | `callId`, `callerId`, `callType` | New incoming call |
| `call_accepted` | `callId`, `userId` | Someone accepted the call |
| `call_rejected` | `callId`, `userId`, `reason?` | Someone rejected the call |
| `call_ended` | `callId`, `endedBy`, `reason` | Call ended |
| `offer` | `fromUserId`, `payload` | Forwarded SDP offer |
| `answer` | `fromUserId`, `payload` | Forwarded SDP answer |
| `ice-candidate` | `fromUserId`, `payload` | Forwarded ICE candidate |
| `error` | `code`, `message` | Error |

**`call_ended` reasons**: `"hangup"`, `"timeout"`, `"declined"`, `"error"`

---

## 9. Error Codes

These are sent via WebSocket `error` messages or HTTP error responses.

### WebSocket Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `INVALID_JSON` | Message is not valid JSON | Fix your JSON serialization |
| `MISSING_TYPE` | Message has no `type` field | Include `type` in every message |
| `UNKNOWN_TYPE` | Unrecognized message type | Check the message type spelling |
| `EMPTY_MESSAGE` | Content is empty or whitespace-only | Validate before sending |
| `MESSAGE_TOO_LONG` | Content exceeds 4096 characters | Truncate or split message |
| `METADATA_TOO_LARGE` | Metadata exceeds 2048 bytes | Reduce metadata size |
| `RATE_LIMITED` | More than 10 messages in 10 seconds | Back off, wait a few seconds |
| `MISSING_FIELD` | Required field missing (e.g., `messageId`) | Include all required fields |
| `EDIT_FAILED` | Message not found, not yours, or deleted | Check messageId and ownership |
| `DELETE_FAILED` | Message not found or not yours | Check messageId and ownership |
| `INVALID_VALUE` | Field value is wrong type (e.g., `lastReadIndex` not a number) | Fix the value type |
| `INTERNAL_ERROR` | Server-side error | Retry once, then report bug |

### HTTP Error Codes

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{ "error": "..." }` | Bad request (missing fields, invalid JSON, etc.) |
| 401 | `{ "error": "Unauthorized" }` | Missing or invalid JWT |
| 403 | `{ "error": "..." }` | Not a member / Not admin / Wrong user |
| 404 | `{ "error": "Not found" }` | Unknown endpoint |
| 429 | `{ "error": "Rate limit exceeded..." }` | REST rate limit hit |
| 502 | `{ "error": "Internal server error" }` | Backend Durable Object failure |

### WebSocket Close Codes

| Code | Meaning |
|------|---------|
| 1000 | Normal close (call ended) |
| 1011 | Too many send failures (server closed your connection) |
| 4003 | You were removed from the conversation |
| 4004 | You left the conversation |

---

## 10. Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| REST API (per IP) | 60 requests | 1 minute |
| WebSocket messages (per user, per conversation) | 10 messages | 10 seconds |

When rate limited:
- REST: Returns `429` status
- WebSocket: Returns `error` with code `RATE_LIMITED`

Client should implement exponential backoff when rate limited.

---

## 11. Constraints & Validation

| Field | Constraint |
|-------|-----------|
| Message content | 1–4096 characters, cannot be empty/whitespace |
| Message metadata | Max 2048 bytes JSON, must be an object |
| User IDs | Non-empty strings |
| Max devices per user | 5 (oldest is dropped) |
| History page size | Max 100 messages per request |
| Sync on connect | Last 50 messages |
| Call ring timeout | 30 seconds |
| Presence auto-offline | 15 minutes with no WebSocket activity |
| Typing auto-clear | 5 seconds after last `typing` event |

---

## 12. Recommended Client Behavior

### Message Sending (Optimistic UI)

1. Generate a `tempId` (UUID) locally
2. Show the message immediately in the UI with a "sending" indicator
3. Send `{ "type": "text", "content": "...", "tempId": "uuid-123" }`
4. On `message_ack` with matching `tempId` → replace with confirmed message (use the server `id`)
5. If no `message_ack` within 5 seconds → show retry button
6. You will also receive the `message` broadcast — deduplicate using `tempId`

### WebSocket Reconnection

1. When the WebSocket closes unexpectedly, reconnect with exponential backoff:
   - 1s → 2s → 4s → 8s → 16s → 30s (max)
2. On reconnect, the server sends a fresh `sync` with the latest 50 messages
3. Compare with your local cache to merge any missed messages
4. For messages older than the sync window, use `GET /history?before=...`

### Typing Indicator

1. When the user starts typing, send `{ "type": "typing" }`
2. **Debounce**: do NOT send on every keystroke. Send at most once every 2–3 seconds while typing continues
3. On receiving `typing` → show "{user} is typing..."
4. On receiving `typing_stopped` → hide the typing indicator
5. Also hide typing on receiving a `message` from that user

### Read Receipts

1. When the user views the latest message (scrolled to bottom), send `mark_read` with that message's `createdAt`
2. Do NOT send `mark_read` for every individual message — only when the user is at the bottom
3. On receiving `read_receipt`, update your UI (e.g., show blue double-check for messages with `createdAt <= lastReadIndex`)

### Background / Foreground

1. **Entering background**: WebSocket will eventually close (OS kills it). This is expected. Rely on push notifications.
2. **Returning to foreground**: Reconnect WebSocket immediately. The `sync` message on reconnect provides the latest messages.
3. **Push tap**: Deep-link to the conversation using `data.conversationId` from the push payload.

### Call Handling

**iOS:**
- On push with `data.type == "call_incoming"` → `CXProvider.reportNewIncomingCall()`
- On CallKit accept → Connect call WebSocket, send `{ "type": "accept" }`, start WebRTC
- On CallKit end → Send `{ "type": "hangup" }`, close WebSocket and PeerConnection

**Android:**
- On FCM with `data.type == "call_incoming"` → Show full-screen intent / heads-up notification
- On user accept → Connect call WebSocket, send `{ "type": "accept" }`, start WebRTC
- On user decline → Connect call WebSocket, send `{ "type": "reject" }`, close
- On user hangup → Send `{ "type": "hangup" }`, close WebSocket and PeerConnection
