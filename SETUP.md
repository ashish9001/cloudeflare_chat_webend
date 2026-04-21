# SETUP.md — Service Configuration Guide

End-to-end setup for the `cloudflare-chat-server` backend. Complete the sections that match the features you need — everything except **Cloudflare** and **AUTH_SECRET** is optional and gates a specific feature.

| Feature | Required config |
|---|---|
| REST + WebSocket chat | Cloudflare, AUTH_SECRET |
| Android push | FCM HTTP v1 |
| iOS push / VoIP push | APNs |
| Media messages (images/video) | Cloudinary (**required**) + R2 (optional, for cleanup) |
| Voice / video calls behind NAT | TURN server |
| Browser clients | ALLOWED_ORIGINS |

All secrets are set with `wrangler secret put <NAME>`. Run it from the repo root — it uploads to the Worker bound in `wrangler.toml` (production by default; add `--env staging` for staging).

---

## 1. Prerequisites

- Node.js 18+
- A Cloudflare account with Workers Paid plan (Durable Objects + SQLite storage class require it)
- `wrangler` CLI (installed via `npm install`)

```bash
npm install
npx wrangler login
```

---

## 2. Cloudflare Workers + Durable Objects

### 2.1 Project binding

`wrangler.toml` already declares four Durable Object classes (`ChatRoom`, `UserSession`, `NotificationRouter`, `CallSignaling`) with the SQLite storage migration `v1`. Do **not** change the migration `tag` or the `new_sqlite_classes` list in place — add a new `[[migrations]]` block if you rename or add classes later.

### 2.2 First deploy

```bash
npm run deploy           # production: worker name "cloudflare-chat"
npm run deploy:staging   # staging:    worker name "cloudflare-chat-staging"
```

The first deploy creates the DO namespaces. Verify:

```bash
curl -s https://<your-worker>.<account>.workers.dev/health
```

### 2.3 Custom domain (optional)

Add a route in the Cloudflare dashboard (Workers → your worker → Triggers → Custom Domains). iOS VoIP push and most production clients expect a stable hostname.

### 2.4 R2 bucket for media cleanup (optional)

The `DELETE /conversations/:id` endpoint purges media under `{conversationId}/` if an R2 bucket binding named `MEDIA_BUCKET` is present. Cloudinary is still the source of truth for serving media; R2 is only used as a cleanup target for files the server itself wrote there. Skip this step if you only use Cloudinary.

To enable:

```bash
npx wrangler r2 bucket create chat-media
```

Then add to `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "chat-media"
```

Redeploy.

---

## 3. AUTH_SECRET (JWT auth)

Used by [src/index.ts](src/index.ts) to verify `Authorization: Bearer <jwt>` tokens (HMAC-SHA256).

```bash
# Generate a strong secret
openssl rand -hex 32

# Store it
npx wrangler secret put AUTH_SECRET
```

- **With `AUTH_SECRET` set**: every request and WebSocket connection must present a valid JWT whose `sub` (or `userId`) claim identifies the user.
- **Without it**: the server runs in **dev mode** — the bearer token is treated as the userId verbatim. Never deploy this to production.

Your auth server signs JWTs with the same secret. Minimal payload:

```json
{ "sub": "user_123", "iat": 1700000000, "exp": 1700086400 }
```

---

## 4. Cloudinary (media uploads)

Powers `POST /media/upload`. The Worker proxies the multipart body to Cloudinary with a signed request — the client never sees the API secret.

### 4.1 Create the account

1. Sign up at <https://cloudinary.com>.
2. Dashboard → **Product Environment Credentials** — copy `Cloud name`, `API Key`, `API Secret`.

### 4.2 Upload a signing preset (optional)

The Worker signs each upload inline (`folder` + `timestamp` + secret → SHA-1). No named upload preset is required. If you want to enforce transformations or moderation, create a preset in **Settings → Upload → Upload presets** and extend [src/index.ts:1152](src/index.ts#L1152) to include `upload_preset` in `paramsToSign` and the form body.

### 4.3 Set secrets

```bash
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
```

### 4.4 Server-enforced limits

- Max file size: **5 MB**
- Allowed MIME: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `video/mp4`, `video/quicktime`
- Uploads land in `chat/{conversationId}/...` on Cloudinary

Tighten these at [src/index.ts:1177-1202](src/index.ts#L1177-L1202) if you need to.

### 4.5 Test

```bash
curl -X POST https://<worker>/media/upload \
  -H "Authorization: Bearer <jwt>" \
  -F "conversationId=dm_alice_bob" \
  -F "file=@./test.jpg"
```

Response returns `{ url, key, type, mimeType, size, metadata }`.

---

## 5. FCM HTTP v1 (Android push)

The legacy `FCM_SERVER_KEY` API was shut down by Google — this project uses **FCM HTTP v1** with OAuth2 access tokens minted from a service-account JWT.

### 5.1 Create a service account

1. Firebase Console → **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → downloads a JSON file.
3. From that JSON, copy three fields:
   - `project_id` → `FCM_PROJECT_ID`
   - `client_email` → `FCM_CLIENT_EMAIL`
   - `private_key` → `FCM_PRIVATE_KEY`

### 5.2 Set secrets

```bash
npx wrangler secret put FCM_PROJECT_ID
npx wrangler secret put FCM_CLIENT_EMAIL
npx wrangler secret put FCM_PRIVATE_KEY
```

**Important** — for `FCM_PRIVATE_KEY`, paste the full PEM including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Newlines must be real newlines (not `\n` literals). If the JSON file has `\n` escapes, convert them before pasting, e.g.:

```bash
jq -r .private_key service-account.json | npx wrangler secret put FCM_PRIVATE_KEY
```

### 5.3 Client registration

Android clients POST their FCM registration token to `/devices`:

```json
{ "token": "<fcm-token>", "platform": "android" }
```

### 5.4 Test

```bash
curl -X POST https://<worker>/test-push \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Hello"}'
```

Check logs: `npm run tail`. A 401 from Google usually means the PEM is malformed; the JWT step logs `FCM_PRIVATE_KEY` diagnostics at [src/notification-router.ts:279](src/notification-router.ts#L279).

---

## 6. APNs (iOS push, token-based JWT)

### 6.1 Create an auth key

1. Apple Developer portal → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name it, enable **Apple Push Notifications service (APNs)**, download the `.p8` file.
3. Note the **Key ID** (shown on the key page) and your **Team ID** (top-right of the developer portal).
4. The **Bundle ID** is the iOS app's bundle identifier (e.g., `com.acme.chat`).

### 6.2 Set secrets

```bash
npx wrangler secret put APNS_KEY_ID        # e.g. ABC123DEF4
npx wrangler secret put APNS_TEAM_ID       # 10-char team ID
npx wrangler secret put APNS_BUNDLE_ID     # com.acme.chat
npx wrangler secret put APNS_PRIVATE_KEY   # full contents of AuthKey_XXXXXXXXXX.p8
```

Paste the `.p8` including the `BEGIN PRIVATE KEY` / `END PRIVATE KEY` lines.

### 6.3 Environment (sandbox vs. production)

The code targets `api.push.apple.com` (production APNs). TestFlight builds use production APNs, so that's usually correct. If you need sandbox APNs for Xcode debug builds, change the host in `notification-router.ts` or gate it on a new env var.

### 6.4 VoIP push

Incoming calls are delivered via APNs. For CallKit on iOS you'll typically want a separate **VoIP services certificate** or a dedicated key with **"Apple Push Notifications service"** enabled on the same bundle — clients register their VoIP token as `platform: "ios-voip"` on `/devices` (extend the handler if you haven't already).

---

## 7. TURN / STUN (WebRTC calls)

`GET /calls/ice-servers` always returns Google public STUN. TURN is only included if both secrets are set — without TURN, calls will fail for users behind symmetric NATs.

### 7.1 Options

- **Self-hosted coturn** with a shared secret ([coturn docs](https://github.com/coturn/coturn)). Generate time-limited REST credentials — this is what the server already does at [src/call-signaling.ts:70-92](src/call-signaling.ts#L70-L92).
- **Cloudflare Calls TURN** — managed, also supports shared-secret REST format.
- **Twilio Network Traversal Service** — different credential format; requires code changes.

### 7.2 Set secrets (coturn-style)

```bash
npx wrangler secret put TURN_SERVER_URL    # e.g. turn:turn.example.com:3478?transport=udp
npx wrangler secret put TURN_SECRET        # static-auth-secret from turnserver.conf
```

Verify:

```bash
curl -s https://<worker>/calls/ice-servers -H "Authorization: Bearer <jwt>" | jq
```

Expect STUN + a TURN entry with `username` (unix-timestamp form) and `credential` (HMAC-SHA1 digest).

---

## 8. CORS (browser clients only)

```bash
npx wrangler secret put ALLOWED_ORIGINS   # https://app.example.com,https://admin.example.com
```

Omit the secret to allow all origins (fine for mobile-only deployments; don't do this with a public web client).

---

## 9. Local development

```bash
npm run dev   # wrangler dev --ip 0.0.0.0 → http://localhost:8787
```

- Secrets set via `wrangler secret put` are **not** available in local dev. Put dev values in `.dev.vars` at the repo root (gitignored):

  ```
  AUTH_SECRET=dev-only-secret
  CLOUDINARY_CLOUD_NAME=...
  CLOUDINARY_API_KEY=...
  CLOUDINARY_API_SECRET=...
  # FCM / APNs: leave unset unless you want to test real push locally
  ```

- Skip `AUTH_SECRET` entirely in dev to use the token-as-userId shortcut.
- `--ip 0.0.0.0` binds to LAN so physical devices on the same network can hit the dev server.

---

## 10. Verify the stack

After deploy, smoke-test each layer:

```bash
BASE=https://<worker>.<account>.workers.dev
JWT=<your-signed-jwt>

# Health
curl -s $BASE/health

# Create a DM
curl -s -X POST $BASE/conversations \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"type":"dm","userIds":["user_bob"]}'

# ICE servers (confirms TURN wiring)
curl -s $BASE/calls/ice-servers -H "Authorization: Bearer $JWT" | jq

# Push (after registering a device)
curl -s -X POST $BASE/test-push \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"title":"ok","body":"ok"}'
```

Stream logs while testing: `npm run tail`.

---

## 11. Secret inventory (copy-paste checklist)

```bash
# Required
npx wrangler secret put AUTH_SECRET

# Media (required for image/video messages)
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET

# Android push
npx wrangler secret put FCM_PROJECT_ID
npx wrangler secret put FCM_CLIENT_EMAIL
npx wrangler secret put FCM_PRIVATE_KEY

# iOS push
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_BUNDLE_ID
npx wrangler secret put APNS_PRIVATE_KEY

# Calls (TURN) — STUN works without these
npx wrangler secret put TURN_SERVER_URL
npx wrangler secret put TURN_SECRET

# Browser CORS (optional)
npx wrangler secret put ALLOWED_ORIGINS
```

List what's already set:

```bash
npx wrangler secret list
npx wrangler secret list --env staging
```

Rotate by running `wrangler secret put` again with the same name; delete with `wrangler secret delete <NAME>`.
