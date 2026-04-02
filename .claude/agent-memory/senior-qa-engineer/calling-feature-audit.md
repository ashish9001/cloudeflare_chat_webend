# Calling Feature Audit — April 2026

## Summary
Audit of call reject REST endpoint + callerImage + notification decline changes.

## Bugs (4 found)

### BUG-1 (High): PendingIntent for CloudflareCallRejectReceiver
File: app/src/main/java/com/kotlin/mNative/fcm/CoreNotificationService.kt lines 891-894
Problem: Uses action-based Intent + setPackage() for PendingIntent.getBroadcast() targeting an exported=false receiver. Unreliable on Android 12+ (targetSdk 35).
Fix: Use Intent(this, CloudflareCallRejectReceiver::class.java) instead.

### BUG-2 (Medium): isPeerConnectionCreating not reset on cancellation
File: socialnetwork2/.../call/SNCloudflareCallActivity.kt createPeerConnection()
Problem: No finally block resets isPeerConnectionCreating=false if lifecycleScope coroutine is cancelled.
Fix: Add try/finally { isPeerConnectionCreating = false } inside the launch block.

### BUG-3 (Medium): Non-@Volatile initialized flag
File: socialnetwork2/.../manager/SNCloudflareChatManager.kt line 37
Problem: `private var initialized = false` — not @Volatile, JVM cross-thread visibility not guaranteed.
Fix: Add @Volatile annotation.

### BUG-4 (Low): onNewIntent() not overridden on singleTop activity
File: socialnetwork2/.../call/SNCloudflareCallActivity.kt
Problem: launchMode=singleTop but onNewIntent() not overridden. Second call notification while activity is on top drops new intent.
Fix: Override onNewIntent() to handle or ignore.

## What Passed
- Server/SDK contract: POST /calls/{id}/reject matches perfectly
- Route ordering: reject regex safely precedes status regex
- callerImage flow: end-to-end verified (fragment -> manager -> SDK -> server -> push -> service -> activity)
- goAsync + finally pattern: pendingResult.finish() correctly in finally
- SDK not initialized guard: notification dismissed, logs warning
- createPeerConnection ended state guard: explicit fix verified working
- onAddStream emptied: correct for Unified Plan SDP semantics
- Thread safety of callManagers/wsManagers: ConcurrentHashMap used
- Server auth: userId sourced from JWT in index.ts, not client input
- Backward compat: null callerImage, old servers without /reject endpoint
