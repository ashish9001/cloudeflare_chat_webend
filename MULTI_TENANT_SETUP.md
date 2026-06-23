# Multi-Tenant Setup — Reusing This Server Across Multiple Apps

This document describes how to run **one deployed Worker that serves many apps**, and exactly
what configuration data each app's developer must provide to onboard it **dynamically**
(no redeploy, no code change per app).

> **Contract:** Every credential below is supplied **at runtime, per app** — nothing is hardcoded
> or baked into a deploy. The single source of truth is the per-app config object in
> [§3](#3-per-app-config-object-the-canonical-contract). If an app provides a complete config, the
> server serves that app fully; if a section is omitted, only that feature is unavailable for that
> app. The server resolves the right config per request from the `appId` carried in the JWT.

---

## 0. Infrastructure & base URL (operator one-time setup — NOT collected per app)

These are set up **once by you (the operator)**, not collected from each app developer. They are not
credentials any app team provides.

**a) Deploy the Worker and get the base URL.** After `wrangler deploy`, the Worker is reachable at a
Cloudflare URL — this is the base URL every client app points to:

| Environment | Base URL (host) |
|-------------|------------------|
| default / dev | `https://cloudflare-chat.<your-account-subdomain>.workers.dev` |
| production | `https://cloudflare-chat-prod.<your-account-subdomain>.workers.dev` |
| custom domain | whatever route you bind in Cloudflare (e.g. `https://chat.example.com`) |

`<your-account-subdomain>` is fixed per Cloudflare account. `wrangler deploy` prints the exact URL,
or find it in **Cloudflare dashboard → Workers & Pages → your worker**. Every client uses this host:
- REST: `https://<host>/conversations`, `https://<host>/devices`, …
- WebSocket chat: `wss://<host>/ws?conversationId=...&token=...`
- WebSocket calls: `wss://<host>/ws/call?callId=...&token=...`

You hand this base URL to each app team — it's the same host for all apps (one shared Worker).

**b) Create the config store + admin secret (one-time):**
- Create a **KV namespace** (e.g. `APP_CONFIG`) and bind it in `wrangler.toml` (default + production envs).
- Set `ADMIN_SECRET` via `wrangler secret put ADMIN_SECRET` — protects the `/admin/apps` endpoints.
- *(Optional)* Set `CONFIG_ENCRYPTION_KEY` via `wrangler secret put` if you encrypt configs at rest in KV.

That's the entire global footprint — **one KV namespace + one admin secret**. Everything else is
per-app and supplied dynamically through the admin API ([§4](#4-onboarding-runbook-per-app)).

---

## 1. The model

- **One Worker deploy** serves all apps. No new deploy when you add an app.
- Every request carries an **`appId`** (from the JWT claim, falling back to an `X-App-Id` header
  or the device-registration body). The server resolves that app's config at runtime.
- Per-app config (credentials) lives in a **Cloudflare KV namespace**, keyed by `appId`, written
  through a protected **admin endpoint**. Adding/rotating an app = one API call, hot-reloaded.
- Durable Object data is **already naturally isolated per app** *if* your conversation / user IDs
  are app-scoped (e.g. `dm_{appId}_{u1}_{u2}`, `user_{appId}_{uid}`). See [§6](#6-data-isolation).

```
client (app A JWT) ─┐
client (app B JWT) ─┼─► Worker ──resolve appId──► KV: app:{appId} ──► {fcm, apns, cloudinary, auth, turn}
client (app C JWT) ─┘                                   │
                                                        └─► passed into DOs (ChatRoom, NotificationRouter, …)
```

---

## 2. What to collect from each app developer (intake checklist)

Send this checklist to each app team. **Two pushes = two sets of credentials** (Android via FCM,
iOS via APNs). Collect only what the app actually uses.

### A. Identity / auth (required)
| Field | What it is | Where to get it |
|-------|-----------|-----------------|
| `appId` | Short stable slug you assign, e.g. `myapp`, `socialnetworknew` | You choose it; the app embeds it in every JWT |
| `auth.secret` | HMAC-SHA256 secret used to **verify** the JWTs this app issues | From whoever mints the app's login JWTs (their backend). Must match exactly. |
| `allowedOrigins` | Web origins allowed for CORS (web clients only) | The app's web domains, e.g. `https://app.example.com` |

### B. Android push — Firebase Cloud Messaging (FCM HTTP v1)
> ⚠️ **Not `google-services.json`.** That file is the *client* config that ships **inside the
> Android app**. The **server** needs a **service-account key**, which is a different JSON.

| Field | What it is | Where to get it |
|-------|-----------|-----------------|
| `fcm.projectId` | Firebase project id | Firebase Console → ⚙ Project settings → General → "Project ID" |
| `fcm.clientEmail` | Service-account email | from the service-account JSON (`client_email`) |
| `fcm.privateKey` | RSA private key (PEM) | from the service-account JSON (`private_key`) |

**How they generate the service-account JSON:** Firebase Console → ⚙ Project settings →
**Service accounts** → **Generate new private key** → downloads a JSON. You need three fields from it:
`project_id`, `client_email`, `private_key`. Keep `\n` newlines intact in `private_key`.

### C. iOS push — APNs (token auth, `.p8`)
> ⚠️ **Not `GoogleService-Info.plist`.** That plist is the iOS *client* Firebase config. For direct
> APNs (what this server uses) you need an **APNs Auth Key (`.p8`)**, not a plist.

| Field | What it is | Where to get it |
|-------|-----------|-----------------|
| `apns.keyId` | 10-char Key ID | Apple Developer → Certificates, IDs & Profiles → **Keys** → the key's ID |
| `apns.teamId` | 10-char Apple Team ID | Apple Developer → Membership |
| `apns.bundleId` | App bundle id (= APNs topic), e.g. `com.company.myapp` | Xcode target / App ID |
| `apns.privateKey` | EC P-256 private key (PEM) | contents of the downloaded `.p8` file |
| `apns.production` | `true` for App Store/TestFlight, `false` for dev sandbox | Build configuration |

**How they generate the `.p8`:** Apple Developer → **Keys** → **+** → enable **Apple Push
Notifications service (APNs)** → Register → **Download** (one-time download). The filename contains
the Key ID (`AuthKey_XXXXXXXXXX.p8`). One key can serve all of a team's apps.

### D. Media uploads — Cloudinary (optional, only if the app sends media)
| Field | Where to get it |
|-------|-----------------|
| `cloudinary.cloudName` | Cloudinary dashboard → Product Environment Credentials |
| `cloudinary.apiKey` | same |
| `cloudinary.apiSecret` | same |

### E. Calls — TURN (optional, only if the app does voice/video)
Either Cloudflare-managed TURN **(preferred)** or a static-secret coturn server:
| Field | Where to get it |
|-------|-----------------|
| `turn.cfKeyId` + `turn.cfApiToken` | Cloudflare dashboard → Realtime → TURN → Create app |
| *or* `turn.staticSecret` + `turn.serverUrl` | Your coturn deployment |

STUN works with no config, so TURN is only needed when clients are behind strict NATs.

---

## 3. Per-app config object (the canonical contract)

This object **is** the dynamic configuration. It is supplied at onboarding, stored in KV under
`app:{appId}` (encrypt at rest — see [§7](#7-security)), and loaded by the server on each request.
Provide a complete object and every feature works for that app; omit a section and only that
feature is disabled for that app. No other configuration source exists.

```jsonc
{
  "appId": "myapp",
  "displayName": "My App",
  "auth": {
    "secret": "<HMAC secret that verifies this app's JWTs>"
  },
  "fcm": {
    "projectId": "myapp-12345",
    "clientEmail": "firebase-adminsdk-xxxx@myapp-12345.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
  },
  "apns": {
    "keyId": "ABCD1234EF",
    "teamId": "TEAM123456",
    "bundleId": "com.company.myapp",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----\n",
    "production": true
  },
  "cloudinary": {
    "cloudName": "myapp-cloud",
    "apiKey": "123456789012345",
    "apiSecret": "<secret>"
  },
  "turn": {
    // Preferred: Cloudflare-managed TURN …
    "cfKeyId": "<optional>",
    "cfApiToken": "<optional>",
    // … or fallback: static-secret coturn
    "staticSecret": "<optional>",
    "serverUrl": "<optional, e.g. turn:turn.example.com:3478>"
  },
  "allowedOrigins": ["https://app.example.com", "https://admin.example.com"]
}
```

Any section may be omitted if the app doesn't use that feature (e.g. no `apns` for an Android-only
app). The server treats a missing section the same way it treats a missing global secret today
(feature simply unavailable for that app).

---

## 4. Onboarding runbook (per app)

1. Assign a unique `appId`.
2. Collect the fields in [§2](#2-what-to-collect-from-each-app-developer-intake-checklist).
3. Build the JSON in [§3](#3-per-app-config-object-the-canonical-contract).
4. `POST /admin/apps` with the JSON (auth: `Authorization: Bearer $ADMIN_SECRET`).
5. Give the app team the **base URL** ([§0](#0-infrastructure--base-url-operator-one-time-setup--not-collected-per-app)) and tell them to:
   - point all REST + WebSocket calls at that host;
   - put `appId` into every JWT they issue (claim `appId`), signed with `auth.secret`;
   - register devices via `POST /devices` with `{ platform, token, appId, userId }`;
   - scope their conversation/user IDs by `appId` (see [§6](#6-data-isolation)).
6. Verify with `POST /test-push` for that app's user.

To rotate a credential: `POST /admin/apps` again with the updated JSON (overwrites). To offboard:
`DELETE /admin/apps/:appId`.

---

## 5. How the server consumes the dynamic config (runtime contract)

For each request the server resolves `appId` → loads `app:{appId}` from KV → uses **only** that
config. This is the mapping from config field to server behavior:

| Config field | Used by | Effect |
|--------------|---------|--------|
| `auth.secret` | Worker JWT verification | Verifies the app's bearer token; identifies the `userId` |
| `appId` (from JWT claim → `X-App-Id` header → `?appId=`) | Worker | Selects which app config to load and scopes DO IDs |
| `fcm.*` | NotificationRouter (Android) | Mints the FCM OAuth token + sends data-only pushes |
| `apns.*` | NotificationRouter (iOS) | Signs the APNs JWT, picks prod/sandbox host + bundle topic |
| `cloudinary.*` | Worker `/media/upload` | Signs and forwards the upload |
| `turn.*` | CallSignaling `/ice-servers` | Returns TURN creds (CF-managed preferred, coturn fallback) |
| `allowedOrigins` | Worker CORS | Allowed origins for that app's web clients |

Resolution order for `appId`: JWT claim `appId` → `X-App-Id` header → `?appId=` query. The config is
cached per isolate and hot-reloads when re-written via the admin endpoint. A missing section means
that feature is simply unavailable for that app — it never falls back to another app's credentials.

**Admin API** (manage configs at runtime, gated by `ADMIN_SECRET`, separate from user auth):
- `POST /admin/apps` — create/replace an app config (body = the [§3](#3-per-app-config-object-the-canonical-contract) object)
- `GET /admin/apps/:appId` — read (with secrets redacted)
- `DELETE /admin/apps/:appId` — offboard an app

---

## 6. Data isolation

The DOs key all state by name (`idFromName`). To keep apps' data separate **scope every ID by
`appId`** at creation time:

- Conversations: `dm_{appId}_{sortedUserIds}` / `group_{appId}_{uuid}` (or your custom prefix that
  already embeds appId, e.g. `socialnetworknew_{appId}_{u1}_{u2}`).
- Users: `user_{appId}_{userId}` for UserSession / NotificationRouter names.
- Calls: `call_{appId}_{uuid}`.

The Worker enforces "users can only touch their own data" via the JWT `userId`; with app-scoped IDs,
app A's tokens can never name app B's DOs. **If you don't scope IDs, two apps with the same numeric
user ids would share a DO** — so this step is required for true isolation.

---

## 7. Security

- **Encrypt config at rest in KV.** Store the `fcm.privateKey` / `apns.privateKey` / `auth.secret`
  encrypted (e.g. AES-GCM with a key from a Worker secret), decrypt in `getAppConfig`. KV values are
  not encrypted for you.
- The **admin endpoints** must use a separate `ADMIN_SECRET`, never a user JWT. Consider IP
  allow-listing or Cloudflare Access in front of `/admin/*`.
- Each app's `auth.secret` is independent — a leak of one app's secret can't forge another app's
  tokens.
- Never log private keys or full tokens (the code already logs only token suffixes).

---

## 8. Quick reference — per-app intake (copy/paste form)

```
appId:                 ____________________
displayName:           ____________________
JWT verify secret:     ____________________            (auth.secret)
Allowed web origins:   ____________________            (comma-separated; web only)

— Android / FCM (service-account JSON) —
project_id:            ____________________
client_email:          ____________________
private_key (PEM):     ____________________

— iOS / APNs (.p8 auth key) —
Key ID:                ____________________
Team ID:               ____________________
Bundle ID:             ____________________
.p8 private key (PEM):  ____________________
Production (y/n):      ____________________

— Media / Cloudinary (optional) —
cloud name / api key / api secret: ____________________

— Calls / TURN (optional) —
CF TURN key id + token, or coturn secret + url: ____________________
```
