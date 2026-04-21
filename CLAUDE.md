# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start local dev server (`wrangler dev --ip 0.0.0.0`, LAN-accessible on `:8787`)
- `npm run deploy` — Deploy to Cloudflare production
- `npm run deploy:staging` — Deploy to staging (`cloudflare-chat-staging`)
- `npm run tail` — Stream logs from the deployed Worker (`wrangler tail`)
- `npm run typecheck` — Run TypeScript type checking (`tsc --noEmit`)
- No test framework is configured; there are no tests.

## Architecture

Cloudflare Workers + Durable Objects real-time chat backend (Twilio replacement). All state is stored in SQLite-backed Durable Objects — no external database.

### Worker Entry Point (`src/index.ts`)

Thin routing/auth layer. Handles CORS, JWT auth (HMAC-SHA256 in production, token-as-userId in dev), REST rate limiting (60 req/min per IP), and forwards to DOs. All REST endpoints require Bearer token or `?token=` query param. Enforces that users can only access their own data (conversations list, etc.).

### Durable Objects

Each DO extends `DurableObject<Env>` from `cloudflare:workers`. Schema created lazily via `ensureSchema()`.

- **ChatRoom** (`src/chat-room.ts`) — One per conversation (`dm_{sortedUserIds}` or `group_{uuid}`). WebSocket via Hibernation API with user tags. Message CRUD with ack (`message_ack`), read receipts, typing with auto-timeout (5s → `typing_stopped`), rate limiting (10 msgs/10s), metadata validation (2KB limit). Group management: add/remove members, leave, update name. Notifies offline members via NotificationRouter push. Tracks send failures and closes dead WebSockets after 3 consecutive failures.

- **UserSession** (`src/user-session.ts`) — One per user (`user_{userId}`). Presence with **connection counting** — tracks which conversations user is connected to, only marks offline when all connections drop. 15-min auto-offline via DO alarm. Stores conversation list with participant metadata in SQLite.

- **NotificationRouter** (`src/notification-router.ts`) — One per user. Stores up to 5 device tokens. **Actually sends push** to FCM HTTP v1 (Android, OAuth2 access token minted from a service-account JWT signed with `FCM_PRIVATE_KEY`) and APNs (iOS, token-based JWT auth). Auto-removes invalid tokens on send failure.

- **CallSignaling** (`src/call-signaling.ts`) — One per call. Full lifecycle: initiate → ring (with push to callee) → accept/reject → hangup. 30-second ring timeout via alarm. WebRTC signaling relay (offer/answer/ICE). STUN servers always included; TURN with time-limited credentials if `TURN_SECRET`/`TURN_SERVER_URL` configured.

### DO Communication

DOs call each other via internal `fetch()`:
- ChatRoom → UserSession: presence connect/disconnect with conversation tracking
- ChatRoom → NotificationRouter: push to offline members on new message
- CallSignaling → NotificationRouter: push for incoming calls

### Key Patterns

- WebSocket tags (`user:{userId}`) for targeted messaging and connection tracking
- Conversation IDs: deterministic for DMs (`dm_` + sorted user IDs), random for groups (`group_` + UUID)
- `safeSend()` tracks consecutive failures per WebSocket, auto-closes dead connections
- REST rate limiting is per-IP in Worker memory; WebSocket rate limiting is per-user in ChatRoom memory

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/conversations` | Create DM or group (accepts client-supplied `name` as conversationId for custom-prefixed DMs) |
| GET | `/conversations/:id/history` | Message history (cursor via `before`, max `limit=100`) |
| GET | `/conversations/:id/summary` | messageCount + caller's lastReadIndex |
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
| DELETE | `/conversations/:id` | Destructive delete for ALL members; also purges R2 media under `{conversationId}/` |
| GET | `/users/:id/conversations` | List user's conversations (own only) |
| GET | `/users/:id/presence` | Get presence |
| POST | `/users/presence/batch` | Bulk presence lookup |
| POST | `/devices` | Register push device |
| POST | `/devices/unregister` | Unregister push device |
| POST | `/calls` | Initiate a call |
| GET | `/calls/:id` | Get call status |
| POST | `/calls/:id/reject` | Reject incoming call |
| GET | `/calls/ice-servers` | Get ICE/TURN servers |
| POST | `/media/upload` | Cloudinary signed-upload passthrough (resource type via `?resource_type=`) |
| POST | `/test-push` | Dev-only: send a test push to the caller's registered devices |

## WebSocket Endpoints

- `wss://host/ws?conversationId=...&token=...` — Chat
- `wss://host/ws/call?callId=...&token=...` — Call signaling

## Environment & Secrets

Set via `wrangler secret put`:
- `AUTH_SECRET` — Enables JWT verification (omit for dev mode, where the bearer token is used as the userId)
- `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` — Android push via FCM HTTP v1 (service-account credentials from Firebase Console → Project Settings → Service accounts). `FCM_PRIVATE_KEY` must be valid PEM.
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` — iOS push via APNs
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — Signed uploads for `/media/upload`
- `TURN_SECRET`, `TURN_SERVER_URL` — TURN server for calls (STUN is always included even without these)
- `ALLOWED_ORIGINS` — Comma-separated CORS origins (omit to allow all)

R2 bucket `MEDIA_BUCKET` is an optional binding in `wrangler.toml`; if present, media files keyed by `{conversationId}/...` are purged on conversation DELETE.

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
