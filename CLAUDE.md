# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start local dev server (`wrangler dev --ip 0.0.0.0`, LAN-accessible on `:8787`)
- `npm run deploy` — Bare `wrangler deploy`; targets the **default** top-level worker `cloudflare-chat` (NOT the isolated prod env)
- `npm run deploy:staging` — Deploy to staging (`cloudflare-chat-staging`)
- `wrangler deploy --env production` — Deploy the isolated production worker `cloudflare-chat-prod` (no npm script; secrets set with `wrangler secret put <NAME> --env production`)
- `npm run tail` — Stream logs from the deployed Worker (`wrangler tail`)
- `npm run typecheck` — Run TypeScript type checking (`tsc --noEmit`)
- No test framework is configured; there are no tests.

There are three fully isolated environments, each with its own DO namespaces: default (`cloudflare-chat`), staging (`cloudflare-chat-staging`), production (`cloudflare-chat-prod`).

## Architecture

Cloudflare Workers + Durable Objects real-time chat backend (Twilio replacement). All state is stored in SQLite-backed Durable Objects — no external database.

### Worker Entry Point (`src/index.ts`)

Thin routing/auth layer. Handles CORS, JWT auth (HMAC-SHA256 in production, token-as-userId in dev), REST rate limiting (60 req/min per IP), and forwards to DOs. All REST endpoints require Bearer token or `?token=` query param. Enforces that users can only access their own data (conversations list, etc.).

### Durable Objects

Each DO extends `DurableObject<Env>` from `cloudflare:workers`. Schema created lazily via `ensureSchema()`.

- **ChatRoom** (`src/chat-room.ts`) — One per conversation (`dm_{sortedUserIds}`, `group_{uuid}`, or a client-supplied custom id). SQLite tables: `messages` (soft-delete via `deleted_at`; per-user hide via `deleted_by` JSON array; `temp_id` for dedup; `reply_to_id` for threading), `members` (`role`, `last_read_index`, per-user `deleted_at` cutoff, `muted`), `reactions` (PK `message_id+user_id+emoji`). WebSocket via Hibernation API with user tags; on connect sends a `sync` payload (≤50 recent messages + lastReadIndex + member metadata). Message CRUD with ack (`message_ack`) and delivery receipts (`message_delivered`), edit/delete, reactions (`add_reaction`/`remove_reaction`), read receipts, typing (5s auto-timeout → `typing_stopped`, plus 3s server-side broadcast cooldown). Limits: message content 4096 chars, metadata 2KB, rate limit 10 msgs/10s per user, max 256 group members. Group management: add/remove members (admin-only), leave (auto-promotes oldest member if last admin leaves), update name, role changes. Notifies non-muted offline members via NotificationRouter push (iOS always pushed even when WS-connected; Android skipped when connected). **No `alarm()`** — typing timeout is tracked in-memory and checked lazily. Uses `ctx.waitUntil()` for fire-and-forget pushes and WhatsApp-style "unhide on new message" (re-adds a hidden conversation to recipients' UserSession lists).

- **UserSession** (`src/user-session.ts`) — One per user (`user_{userId}`). Presence stored in DO **KV storage** (key `presence`), not SQLite, with **connection counting** — tracks which conversations the user is WS-connected to (a Set), only marks offline when all connections drop. 15-min auto-offline via DO `alarm()`. The conversation list lives in **SQLite** (`conversations` with per-user `deleted_at` for hide + `feature` column; `conversation_participants` with cached name/email/image). `GET /conversations` fans out to each ChatRoom's `/summary` for unread counts and backfills missing participant metadata from ChatRoom's stored participants.

- **NotificationRouter** (`src/notification-router.ts`) — One per user. Stores up to **10** device tokens (DO storage key `devices`, trimmed to the 10 most recent). **Actually sends push** to FCM HTTP v1 (Android — **data-only** messages, `android.priority: HIGH`; OAuth2 access token minted from a service-account JWT signed with `FCM_PRIVATE_KEY`, cached module-level ~55 min) and APNs (iOS — ES256 JWT auth, fresh per push; supports VoIP/PushKit pushes via `voipToken` and sandbox hosts). Optional `platforms` filter restricts delivery (e.g. iOS-only). Auto-removes invalid tokens (FCM `UNREGISTERED`/404; APNs 410/`BadDeviceToken`/`Unregistered`/`DeviceTokenNotForTopic`).

- **CallSignaling** (`src/call-signaling.ts`) — One per call. Call metadata in DO storage. Supports 1:1 lifecycle (initiate → ring with push → accept/reject → hangup) **and multi-party "room" mode** (`room_participants`, `participant_joined`, `participant_left`, `room_sync`). 30-second ring timeout via `alarm()` (also used for a 1s deferred WS close). WebRTC signaling relay (`offer`/`answer`/`ice-candidate`). ICE servers: Google STUN always included; for TURN it **prefers Cloudflare managed TURN** (`CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN`, credentials fetched from `rtc.live.cloudflare.com` and cached 4h), falling back to static-secret coturn (`TURN_SECRET`/`TURN_SERVER_URL`, HMAC-SHA1 time-limited creds).

### DO Communication

DOs call each other via internal `fetch()` (`https://internal/...` URLs):
- ChatRoom → UserSession: presence connect/disconnect with conversation tracking; add/remove/update conversations and participants in the user's conversation list; fetch participants/list for push sender names
- ChatRoom → NotificationRouter: push to non-muted offline members on new message
- CallSignaling → NotificationRouter: push for incoming/accepted/rejected/ended calls
- UserSession → ChatRoom: `/summary` (unread counts) and `/stored-participants` (backfill) when building a user's conversation list

### Key Patterns

- WebSocket tags (`user:{userId}`) for targeted messaging and connection tracking
- Conversation IDs: deterministic for DMs (`dm_` + sorted user IDs), random for groups (`group_` + UUID), or a client-supplied custom name (any non-`group_`-prefixed string, e.g. `socialnetworknew_{appId}_{u1}_{u2}`)
- Message IDs: `msg_{timestamp}_{uuid}` — the embedded timestamp doubles as the pagination cursor for `?before=`
- **Three independent soft-delete layers**: `messages.deleted_at` (hidden for everyone), `messages.deleted_by` (per-user single-message hide), `members.deleted_at` (per-user cutoff — hides all messages older than the timestamp; powers clear-chat and hide-conversation, and persists across re-join). Hiding a conversation does **not** clear `deleted_at`; a new message re-surfaces the conversation in the list but still hides pre-cutoff messages.
- `safeSend()` tracks consecutive failures per WebSocket, auto-closes dead connections after 3
- REST rate limiting is per-IP in Worker memory; WebSocket rate limiting is per-user in ChatRoom memory — both reset on DO/Worker eviction
- All timestamps are Unix milliseconds

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/conversations` | Create DM or group (accepts client-supplied `name` as conversationId for custom-prefixed DMs; optional `feature` tag and `participants` metadata) |
| GET | `/conversations/:id/history` | Message history (cursor via `before`, default `limit=50`, max `100`); respects caller's per-user hides |
| GET | `/conversations/:id/summary` | messageCount, caller's lastReadIndex, unreadCount, lastMessage, lastUnreadMessage, hidden flag |
| GET | `/conversations/:id/members` | List members |
| POST | `/conversations/:id/members` | Add members (admin only) |
| POST | `/conversations/:id/members/remove` | Remove members (admin only) |
| POST | `/conversations/:id/members/role` | Promote/demote member (admin only) |
| POST | `/conversations/:id/leave` | Leave group |
| POST | `/conversations/:id/mute` / `/unmute` | Per-user mute state |
| POST | `/conversations/:id/hide` | Per-user unjoin (swipe-to-delete): removes caller from ChatRoom members + soft-deletes in UserSession |
| POST | `/conversations/:id/clear` | Per-user clear chat (hides all existing messages for caller) |
| POST | `/conversations/:id/messages/:messageId/hide` | Per-user hide of a single message |
| PUT | `/conversations/:id` | Update group (name) |
| DELETE | `/conversations/:id` | Destructive delete for ALL members (admin-only for groups, any member for DMs); also purges R2 media under `{conversationId}/` if `MEDIA_BUCKET` is bound |
| GET | `/users/:id/conversations` | List user's conversations (own only) |
| GET | `/users/:id/presence` | Get presence |
| POST | `/users/presence/batch` | Bulk presence lookup |
| POST | `/devices` | Register push device. Keys the NotificationRouter on the **body's `userId`** (numeric) when present, not the auth token — the auth identity may be a compound Twilio-era id while pushes target the numeric userId |
| POST | `/devices/unregister` | Unregister push device |
| POST | `/calls` | Initiate a call (optional client-supplied deterministic `callId` matching `[A-Za-z0-9_-]{8,64}` for pre-joinable meeting rooms) |
| GET | `/calls/:id` | Get call status |
| POST | `/calls/:id/reject` | Reject incoming call |
| GET | `/calls/ice-servers` | Get ICE/TURN servers |
| POST | `/media/upload` | Cloudinary signed-upload passthrough (multipart `file` + `conversationId`; type allowlist; 5MB images / 20MB video·audio·docs; resource type derived from MIME) |
| POST | `/test-push` | Send a test push to `body.userId` (or the caller) — returns registered devices + push result |

## WebSocket Endpoints

- `wss://host/ws?conversationId=...&token=...` — Chat
- `wss://host/ws/call?callId=...&token=...` — Call signaling

## Environment & Secrets

Set via `wrangler secret put`:
- `AUTH_SECRET` — Enables JWT verification (omit for dev mode, where the bearer token is used as the userId)
- `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` — Android push via FCM HTTP v1 (service-account credentials from Firebase Console → Project Settings → Service accounts). `FCM_PRIVATE_KEY` must be valid PEM.
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` — iOS push via APNs
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — Signed uploads for `/media/upload`
- `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` — **Preferred** TURN: Cloudflare Realtime managed TURN (dashboard → Realtime → TURN). Used over the static pair below when present.
- `TURN_SECRET`, `TURN_SERVER_URL` — Fallback static-secret coturn TURN server for calls (STUN is always included even without any TURN config)
- `ALLOWED_ORIGINS` — Comma-separated CORS origins (omit to allow all)

R2 bucket `MEDIA_BUCKET` is an optional binding (typed in `src/types.ts`, but **not currently bound in `wrangler.toml`** — add the binding to enable it); if present, media files keyed by `{conversationId}/...` are purged on conversation DELETE. Note: actual media uploads go to Cloudinary via `/media/upload`, not R2.

## Agent Behavior Rules

Claude acts as the **most senior web developer** on this project. Follow these rules strictly:

### Identity & Mindset
- You own this codebase. You know every file, every pattern, every edge case.
- Think before coding. Read the relevant files first. Trace the full request path.
- Prefer correctness over speed. A working solution beats a fast broken one.

### Implementation Rules
1. **Read before write** — Always read the source files you're about to modify. Never guess at existing code.
2. **Types first** — Add/update types in `src/types.ts` before implementing logic.
3. **Follow the patterns** — Match existing code style exactly:
   - DOs: `ensureSchema()` guard → SQLite → internal fetch for DO-to-DO
   - WebSocket: tags (`user:{userId}`), `safeSend()`, `broadcastExcept()`
   - REST: auth check → input validation → DO delegation → JSON response
   - IDs: `msg_{timestamp}_{uuid}`, `dm_{sorted}`, `group_{uuid}`
4. **Validate everything** — All user input must be validated. Check message length (4KB), metadata (2KB), membership, roles.
5. **Security always** — Auth on every endpoint. Membership checks. No SQL injection. Rate limits.
6. **No over-engineering** — Minimal changes only. No extra abstractions, no unnecessary deps.

### Bug Fixing Rules
1. **Find root cause** — Don't patch symptoms. Trace the bug to its origin.
2. **Minimal fix** — Change only what's necessary to fix the bug.
3. **Check edge cases** — Consider race conditions, disconnects, empty states, concurrent requests.
4. **Verify** — Run `npm run typecheck` after every fix.

### Server Management
- Check server status: `lsof -i :8787`
- Restart when needed: kill existing process, then `npm run dev`
- After code changes that affect runtime behavior, restart the dev server
- Always verify server is responding after restart: `curl -s http://localhost:8787/health`

### Slash Commands Available
- `/dev <feature description>` — Implement a new feature following all patterns
- `/fix <bug description>` — Identify and fix a bug properly
- `/restart` — Restart the local dev server cleanly
- `/review [files or area]` — Code review with security/correctness/pattern checks
- `/deploy [staging|production]` — Deploy with pre-flight checks
- `/health` — Run comprehensive health check on local server

### Code Quality Gates
Before considering any change complete:
1. `npm run typecheck` must pass with zero errors
2. No `any` types introduced
3. All new endpoints have auth + validation
4. WebSocket messages use `safeSend()`
5. Server restarted if runtime behavior changed
