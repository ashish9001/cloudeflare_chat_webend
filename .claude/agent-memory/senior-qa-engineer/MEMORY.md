# Senior QA Engineer Memory

## Project Architecture
- Android: MVVM + Dagger DI, 40+ modules, socialnetwork2 is active dynamic feature
- Cloudflare server: Workers + Durable Objects, TypeScript
- SDK: standalone Kotlin, no Dagger, OkHttp + Retrofit + Gson

## Confirmed Bug Patterns

### 1. PendingIntent for unexported BroadcastReceivers (Android 12+ / targetSdk 35)
- Using `Intent()` + action string + `setPackage()` for a `PendingIntent.getBroadcast()` targeting an `exported="false"` receiver is unreliable on Android 12+
- ALWAYS use `Intent(context, ReceiverClass::class.java)` for explicit component targeting
- Affected file pattern: FCM service creating notification action PendingIntents

### 2. isPeerConnectionCreating flag — FIXED with finally block
- SNCloudflareCallActivity `createPeerConnection()` now has `finally { isPeerConnectionCreating = false }` at line 370
- All callsite access is on Main thread (runOnUiThread), so no @Volatile needed here
- Pattern confirmed: boolean guards before coroutines need finally block

### 3. Non-@Volatile singleton flags in objects — PARTIALLY FIXED
- SNCloudflareChatManager.initialized is now @Volatile (confirmed line 37-38)
- CloudflareChatClient.config is NOT @Volatile but read in isInitialized() without synchronization — JMM violation
- Fix: add @Volatile to CloudflareChatClient.config private var

### 4. SDK-Server contract mismatch: REST reject missing userId
- CRITICAL: CloudflareChatClient.rejectCallRest() and rejectCallStandalone() send no userId in body
- Server handleRestReject() requires {"userId": "..."} in body — returns 400 otherwise
- All Decline notification actions silently fail on server side
- Fix: add RejectCallRequest(userId, reason) body to ApiService.rejectCallRest(), or modify server to extract userId from JWT auth header

## Architecture Notes

### Cloudflare Chat Call Flow
- REST: POST /calls → index.ts → CallSignaling DO /initiate → push via NotificationRouter
- Push payload: source=cloudflare-chat, type=call_incoming, callId, callerId, callerName, callerImage, callType, feature
- CoreNotificationService reads push → showCloudflareCallNotification()
- Full-screen intent → SNCloudflareCallActivity (exported=true, singleTop)
- Decline button → CloudflareCallRejectReceiver (exported=false) → REST POST /calls/{id}/reject

### Key Rule: Index.ts route ordering
- /calls/ice-servers (explicit) MUST precede /calls/{callId} regex
- /calls/{callId}/reject MUST precede /calls/{callId} regex
- [^/]+ regex cannot match across '/' so no cross-segment shadowing is possible

### goAsync() in BroadcastReceivers
- Always wrap async work in try/finally with pendingResult.finish() in finally
- goAsync window is 10s on pre-API 31, extended on newer APIs
- Always add withTimeout(8_000) around network calls to stay within window

### 5. auto-accept timing race in SNCloudflareCallActivity.onNewIntent()
- If onCallStatus("ringing") fires BEFORE user taps Accept on notification, pendingAutoAccept is consumed
- onNewIntent re-sets pendingAutoAccept=true but onCallStatus won't fire again — flag never consumed
- User is stuck on incoming layout. Fix: in onNewIntent, if peerConnection != null or isCallActive, call onAcceptClicked() immediately

### 6. notificationStackItems.contains() is dead code
- CoreNotificationStackItem is a data class with timeInMilliSeconds; equality always fails (different timestamps)
- The line 288 contains() check never deduplicates; real dedup is at lines 291-298
- notificationStackItems list grows unbounded for FCM service lifetime (minor memory leak)
- Fix: remove line 288 check or use content-only equality

### 7. Thread.sleep(500) blocks call notification path
- onMessageReceived() calls Thread.sleep(500) BEFORE Cloudflare detection for ALL FCM messages
- Introduces 500ms artificial delay before call ring notification fires
- Fix: detect Cloudflare calls before the sleep and bypass it for call_incoming type

## Common Test Checklist for Call Features
- [ ] SDK not initialized when receiver fires
- [ ] Call already ended when reject REST arrives (server must handle gracefully)
- [ ] callerImage null/empty chain (server || "", client ?: "", Glide guard)
- [ ] isPeerConnectionCreating stuck on fast lifecycle events
- [ ] @Volatile on cross-thread boolean flags
- [ ] exported=true + missing onNewIntent() on singleTop activities
- [ ] PendingIntent using component vs action-based intent
- [ ] rejectCallRest/rejectCallStandalone userId body presence (SDK-server contract)
- [ ] auto-accept flag consumed before onNewIntent fires
- [ ] goAsync() + withTimeout(8_000) for all network calls in BroadcastReceivers

See calling-feature-audit.md for full audit details.
