# Cloudflare Chat Server

Cloudflare Workers + Durable Objects backend for real-time chat (Twilio replacement).

## Phases Implemented

- **Phase 1**: 1:1 chat, history, edit/delete
- **Phase 2**: Group chat, read/unread receipts
- **Phase 3**: UserSession DO – presence (online/offline)
- **Phase 4**: NotificationRouter DO – push device registration
- **Phase 5**: CallSignaling DO – voice/video signaling stub
- **Phase 6**: Cutover-ready; migrate Twilio clients to use this backend

## Quick Start

```bash
npm install
npm run dev      # Local dev with wrangler dev
npm run deploy   # Deploy to Cloudflare
```

## API

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/conversations/:id/history?before=&limit=` | Message history (cursor) |
| POST | `/conversations` | Create DM or group `{ userIds, type?, name? }` |
| POST | `/devices` | Register push device |
| GET | `/users/:id/presence` | Get presence |

### WebSocket

- **Connect**: `wss://your-worker/ws?conversationId=dm_user1_user2&token=<auth>`
- **Auth**: Bearer token or `?token=` query param
- **Client messages**: `{ type: "text", content }`, `{ type: "edit", messageId, newContent }`, `{ type: "delete", messageId }`, `{ type: "typing" }`, `{ type: "mark_read", lastReadIndex }`
- **Server messages**: `sync`, `message`, `message_edited`, `message_deleted`, `read_receipt`, `typing`, `error`, `pong`

## Secrets

```bash
wrangler secret put AUTH_SECRET   # Optional; enables JWT validation
wrangler secret put FCM_SERVER_KEY # Phase 4 push
```
# cloudeflare_chat_webend
