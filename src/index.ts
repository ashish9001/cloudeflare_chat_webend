/**
 * Cloudflare Chat Server - Main Worker
 * Handles HTTP routing, WebSocket upgrade, auth, and rate limiting
 */

import type { Env } from "./types";

// Export Durable Objects for wrangler
export { ChatRoom } from "./chat-room";
export { UserSession } from "./user-session";
export { NotificationRouter } from "./notification-router";
export { CallSignaling } from "./call-signaling";

// ============ Rate Limiting (per-IP for REST endpoints) ============

const REST_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const REST_RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRestRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + REST_RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > REST_RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }
  return false;
}

// Periodically clean up stale entries (every 100 calls)
let cleanupCounter = 0;
function maybeCleanupRateLimit(): void {
  cleanupCounter++;
  if (cleanupCounter >= 100) {
    cleanupCounter = 0;
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    }
  }
}

// ============ Auth Helpers ============

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : null;

  const allowedOrigin =
    allowedOrigins === null
      ? "*"
      : allowedOrigins.includes(origin)
        ? origin
        : "";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function verifyJwt(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  try {
    // Validate header algorithm
    const headerDecoded = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(header))
    );
    if (headerDecoded.alg !== "HS256") return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const data = new TextEncoder().encode(`${header}.${payload}`);
    const sig = base64UrlDecode(signature);

    const valid = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!valid) return null;

    const decoded = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload))
    );

    // Check expiration
    if (decoded.exp && decoded.exp < Date.now() / 1000) return null;

    // Check not-before / issued-in-future
    if (decoded.iat && decoded.iat > Date.now() / 1000 + 60) return null;

    return decoded;
  } catch {
    return null;
  }
}

async function getAuth(
  request: Request,
  env: Env
): Promise<{ userId: string } | null> {
  const authHeader = request.headers.get("Authorization");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");

  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken;

  if (!token) return null;

  // Production: verify JWT signature
  if (env.AUTH_SECRET) {
    const decoded = await verifyJwt(token, env.AUTH_SECRET);
    if (!decoded) return null;

    const userId =
      (decoded.userId as string) || (decoded.sub as string) || null;
    return userId ? { userId } : null;
  }

  // Development: base64 decode payload or use token as userId
  try {
    const decoded = JSON.parse(atob(token.split(".")[1] || token));
    if (decoded.userId) return { userId: decoded.userId };
  } catch {
    return { userId: token };
  }
  return null;
}

function safeParseInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function forwardToDO(
  stub: DurableObjectStub,
  url: string,
  init: RequestInit,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    return await stub.fetch(url, init);
  } catch (e) {
    console.error("Durable Object request failed:", e);
    return jsonResponse(
      {
        error: "Internal server error",
        detail: e instanceof Error ? e.message : "DO request failed",
      },
      502,
      corsHeaders
    );
  }
}

// ============ Main Worker ============

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const corsHeaders = getCorsHeaders(request, env);

    // Block disallowed origins
    if (
      env.ALLOWED_ORIGINS &&
      corsHeaders["Access-Control-Allow-Origin"] === ""
    ) {
      return jsonResponse({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check (no auth, no rate limit)
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", version: "v3-unjoin" }, 200, corsHeaders);
    }

    // REST rate limiting (skip for WebSocket upgrade)
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      maybeCleanupRateLimit();
      if (isRestRateLimited(clientIp)) {
        return jsonResponse(
          { error: "Rate limit exceeded. Try again later." },
          429,
          corsHeaders
        );
      }
    }

    // ============ WebSocket: Chat ============
    if (url.pathname === "/ws") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = url.searchParams.get("conversationId");
      if (!conversationId) {
        return jsonResponse({ error: "Missing conversationId" }, 400, corsHeaders);
      }

      url.searchParams.delete("token");
      url.searchParams.set("userId", auth.userId);
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      return forwardToDO(
        stub,
        url.toString(),
        { headers: request.headers },
        corsHeaders
      );
    }

    // ============ WebSocket: Call Signaling ============
    if (url.pathname === "/ws/call") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const callId = url.searchParams.get("callId");
      if (!callId) {
        return jsonResponse({ error: "Missing callId" }, 400, corsHeaders);
      }

      url.searchParams.delete("token");
      url.searchParams.set("userId", auth.userId);
      const id = env.CALL_SIGNALING.idFromName(callId);
      const stub = env.CALL_SIGNALING.get(id);
      return forwardToDO(
        stub,
        url.toString(),
        { headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Message History ============
    const historyMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/history$/
    );
    if (historyMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = historyMatch[1];
      const before = url.searchParams.get("before");
      const limit = Math.min(safeParseInt(url.searchParams.get("limit"), 50), 100);

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/history";
      doUrl.searchParams.set("before", before || "");
      doUrl.searchParams.set("limit", limit.toString());
      // Use the authenticated userId — not from query param
      doUrl.searchParams.set("userId", auth.userId);

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Conversation Summary (messageCount, lastReadIndex) ============
    const summaryMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/summary$/
    );
    if (summaryMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = summaryMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/summary";
      doUrl.searchParams.set("userId", auth.userId);

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Create Conversation ============
    if (url.pathname === "/conversations" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let body: {
        type?: string;
        userIds: string[];
        name?: string;
        feature?: string;
        participants?: Array<{ userId: string; name?: string; email?: string; image?: string }>;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      const userIds = body.userIds || [];
      const name = body.name as string | undefined;

      if (userIds.length === 0) {
        return jsonResponse({ error: "userIds required" }, 400, corsHeaders);
      }

      const invalidIds = userIds.filter(
        (id) => typeof id !== "string" || id.trim().length === 0
      );
      if (invalidIds.length > 0) {
        return jsonResponse({ error: "userIds must be non-empty strings" }, 400, corsHeaders);
      }

      const uniqueUserIds = [
        ...new Set([auth.userId, ...userIds.map((id) => id.trim())]),
      ];

      const sortedIds = [...uniqueUserIds].sort();

      // Validate custom name doesn't collide with reserved prefixes
      if (name && body.type !== "group" && name.startsWith("group_")) {
        return jsonResponse(
          { error: "Conversation name cannot start with 'group_'" },
          400,
          corsHeaders
        );
      }

      // Use client-provided name as conversationId if given (e.g. socialnetworknew_{appId}_{user1}_{user2})
      // Otherwise fall back to default dm_{sorted} format
      const conversationId =
        body.type === "group"
          ? `group_${crypto.randomUUID()}`
          : name || `dm_${sortedIds.join("_")}`;

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/init";
      const initBody = {
        conversationId,
        creatorId: auth.userId,
        type: body.type || (uniqueUserIds.length > 2 ? "group" : "dm"),
        memberIds:
          body.type === "group" ? uniqueUserIds : sortedIds,
        name: body.type === "group" ? name : undefined,
        feature: body.feature,
        participants: body.participants,
      };
      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initBody),
        },
        corsHeaders
      );
    }

    // ============ REST: Group Member Management ============

    // Add members to group
    const addMembersMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/members$/
    );
    if (addMembersMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = addMembersMatch[1];
      let body: { userIds: string[]; participants?: Array<{ userId: string; name?: string; email?: string; image?: string }> };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      if (!body.userIds?.length) {
        return jsonResponse({ error: "userIds required" }, 400, corsHeaders);
      }

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/members/add";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId: auth.userId,
            userIds: body.userIds,
            conversationId,
            participants: body.participants,
          }),
        },
        corsHeaders
      );
    }

    // Remove members from group
    const removeMembersMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/members\/remove$/
    );
    if (removeMembersMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = removeMembersMatch[1];
      let body: { userIds: string[] };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      if (!body.userIds?.length) {
        return jsonResponse({ error: "userIds required" }, 400, corsHeaders);
      }

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/members/remove";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId: auth.userId,
            userIds: body.userIds,
            conversationId,
          }),
        },
        corsHeaders
      );
    }

    // Change member role (promote/demote)
    const roleChangeMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/members\/role$/
    );
    if (roleChangeMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = roleChangeMatch[1];
      let body: { userId: string; role: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      if (!body.userId || !body.role) {
        return jsonResponse({ error: "userId and role required" }, 400, corsHeaders);
      }

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/members/role";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId: auth.userId,
            userId: body.userId,
            role: body.role,
          }),
        },
        corsHeaders
      );
    }

    // List members
    const listMembersMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/members$/
    );
    if (listMembersMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = listMembersMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/members";

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // Leave group
    const leaveMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/leave$/
    );
    if (leaveMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = leaveMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/leave";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: auth.userId,
            conversationId,
          }),
        },
        corsHeaders
      );
    }

    // ============ REST: Mute/Unmute Conversation ============
    const muteMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/mute$/
    );
    if (muteMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = muteMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/mute";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: auth.userId }),
        },
        corsHeaders
      );
    }

    const unmuteMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/unmute$/
    );
    if (unmuteMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = unmuteMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/unmute";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: auth.userId }),
        },
        corsHeaders
      );
    }

    // ============ REST: Unjoin Conversation (swipe-to-delete) ============
    const hideConvMatch = url.pathname.match(
      /^\/conversations\/([^/]+)\/hide$/
    );
    if (hideConvMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = hideConvMatch[1];

      try {
        // 1. Remove user from ChatRoom members (unjoin)
        const chatRoomId = env.CHAT_ROOM.idFromName(conversationId);
        const chatRoomStub = env.CHAT_ROOM.get(chatRoomId);
        const hideResp = await chatRoomStub.fetch("https://internal/hide-for-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: auth.userId }),
        });

        if (!hideResp.ok) {
          let hideResult: unknown;
          try {
            hideResult = await hideResp.json();
          } catch {
            hideResult = { error: await hideResp.text() || "ChatRoom error" };
          }
          return jsonResponse(hideResult, hideResp.status, corsHeaders);
        }

        // 2. Remove conversation from UserSession (no longer in user's list)
        const userSessionId = env.USER_SESSION.idFromName(`user_${auth.userId}`);
        const userSessionStub = env.USER_SESSION.get(userSessionId);
        await userSessionStub.fetch("https://internal/conversations/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId }),
        });

        return jsonResponse(
          { ok: true, conversationId, unjoinedFor: auth.userId },
          200,
          corsHeaders
        );
      } catch (e) {
        console.error("Failed to unjoin conversation:", e);
        return jsonResponse(
          { error: "Failed to unjoin conversation" },
          500,
          corsHeaders
        );
      }
    }

    // Delete conversation (destructive — removes for ALL members)
    const deleteConvMatch = url.pathname.match(
      /^\/conversations\/([^/]+)$/
    );
    if (deleteConvMatch && request.method === "DELETE") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = deleteConvMatch[1];
      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/delete";

      const response = await forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId: auth.userId,
            conversationId,
          }),
        },
        corsHeaders
      );

      // Clean up R2 media files for this conversation (best-effort, only if R2 is configured)
      if (response.ok && env.MEDIA_BUCKET) {
        try {
          const listed = await env.MEDIA_BUCKET.list({ prefix: `${conversationId}/` });
          if (listed.objects.length > 0) {
            await Promise.all(
              listed.objects.map((obj) => env.MEDIA_BUCKET!.delete(obj.key))
            );
          }
        } catch (e) {
          console.error("R2 cleanup failed for conversation:", conversationId, e);
        }
      }

      return response;
    }

    // Update conversation (name, etc.)
    const updateConvMatch = url.pathname.match(
      /^\/conversations\/([^/]+)$/
    );
    if (updateConvMatch && request.method === "PUT") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const conversationId = updateConvMatch[1];
      let body: { name?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      const id = env.CHAT_ROOM.idFromName(conversationId);
      const stub = env.CHAT_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/update";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId: auth.userId,
            name: body.name,
          }),
        },
        corsHeaders
      );
    }

    // ============ REST: Push Device Registration ============
    if (url.pathname === "/devices" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      console.log(`[DEVICES] POST /devices — registering device for userId=${auth.userId}`);
      const id = env.NOTIFICATION_ROUTER.idFromName(`user_${auth.userId}`);
      const stub = env.NOTIFICATION_ROUTER.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/register";
      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "POST", headers: request.headers, body: request.body },
        corsHeaders
      );
    }

    // Unregister device
    if (url.pathname === "/devices/unregister" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const id = env.NOTIFICATION_ROUTER.idFromName(`user_${auth.userId}`);
      const stub = env.NOTIFICATION_ROUTER.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/unregister";
      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "POST", headers: request.headers, body: request.body },
        corsHeaders
      );
    }

    // ============ REST: User Conversations (auth-verified) ============
    const conversationsMatch = url.pathname.match(
      /^\/users\/([^/]+)\/conversations$/
    );
    if (conversationsMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const targetUserId = conversationsMatch[1];

      // Users can only list their own conversations
      if (auth.userId !== targetUserId) {
        return jsonResponse(
          { error: "Forbidden: can only access your own conversations" },
          403,
          corsHeaders
        );
      }

      const id = env.USER_SESSION.idFromName(`user_${targetUserId}`);
      const stub = env.USER_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/conversations";
      doUrl.searchParams.set("userId", targetUserId);

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Presence (auth-verified) ============
    const presenceMatch = url.pathname.match(/^\/users\/([^/]+)\/presence$/);
    if (presenceMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const targetUserId = presenceMatch[1];
      const id = env.USER_SESSION.idFromName(`user_${targetUserId}`);
      const stub = env.USER_SESSION.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/presence";
      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Batch Presence ============
    if (url.pathname === "/users/presence/batch" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let body: { userIds: string[] };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
        return jsonResponse({ error: "userIds array required" }, 400, corsHeaders);
      }
      // Cap at 50 to prevent abuse
      const userIds = body.userIds.slice(0, 50);

      const results: Record<string, { status: string; lastSeen: number; activeConversations: number }> = {};
      await Promise.all(
        userIds.map(async (userId) => {
          try {
            const id = env.USER_SESSION.idFromName(`user_${userId}`);
            const stub = env.USER_SESSION.get(id);
            const doUrl = new URL(request.url);
            doUrl.pathname = "/presence";
            const resp = await stub.fetch(doUrl.toString(), {
              method: "GET",
              headers: request.headers,
            });
            if (resp.ok) {
              results[userId] = (await resp.json()) as { status: string; lastSeen: number; activeConversations: number };
            } else {
              results[userId] = { status: "offline", lastSeen: 0, activeConversations: 0 };
            }
          } catch {
            results[userId] = { status: "offline", lastSeen: 0, activeConversations: 0 };
          }
        })
      );

      return jsonResponse({ presences: results }, 200, corsHeaders);
    }

    // ============ REST: Call Signaling ============

    // Get ICE servers (MUST be before /calls/{callId} regex to avoid shadowing)
    if (url.pathname === "/calls/ice-servers" && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      // Use a fixed DO name for ICE server config
      const id = env.CALL_SIGNALING.idFromName("ice-servers");
      const stub = env.CALL_SIGNALING.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/ice-servers";

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // Initiate a call
    if (url.pathname === "/calls" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let body: {
        targetUserIds: string[];
        callType: "voice" | "video";
        callerName?: string;
        callerImage?: string;
        feature?: string;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      if (!body.targetUserIds?.length) {
        return jsonResponse({ error: "targetUserIds required" }, 400, corsHeaders);
      }
      if (body.callType !== "voice" && body.callType !== "video") {
        return jsonResponse({ error: "callType must be 'voice' or 'video'" }, 400, corsHeaders);
      }

      const callId = `call_${crypto.randomUUID()}`;
      const id = env.CALL_SIGNALING.idFromName(callId);
      const stub = env.CALL_SIGNALING.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/initiate";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callId,
            callerId: auth.userId,
            targetUserIds: body.targetUserIds,
            callType: body.callType,
            callerName: body.callerName,
            callerImage: body.callerImage,
            feature: body.feature,
          }),
        },
        corsHeaders
      );
    }

    // Reject call via REST (no WS needed — used by notification dismiss)
    const callRejectMatch = url.pathname.match(/^\/calls\/([^/]+)\/reject$/);
    if (callRejectMatch && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const callId = callRejectMatch[1];
      const id = env.CALL_SIGNALING.idFromName(callId);
      const stub = env.CALL_SIGNALING.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/reject";

      return forwardToDO(
        stub,
        doUrl.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: auth.userId,
            reason: "declined",
          }),
        },
        corsHeaders
      );
    }

    // Get call status
    const callStatusMatch = url.pathname.match(/^\/calls\/([^/]+)$/);
    if (callStatusMatch && request.method === "GET") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const callId = callStatusMatch[1];
      const id = env.CALL_SIGNALING.idFromName(callId);
      const stub = env.CALL_SIGNALING.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/status";

      return forwardToDO(
        stub,
        doUrl.toString(),
        { method: "GET", headers: request.headers },
        corsHeaders
      );
    }

    // ============ REST: Media Upload ============
    if (url.pathname === "/media/upload" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return jsonResponse({ error: "Invalid multipart/form-data" }, 400, corsHeaders);
      }

      const file = formData.get("file") as File | null;
      const conversationId = formData.get("conversationId") as string | null;

      if (!file) {
        return jsonResponse({ error: "Missing 'file' field" }, 400, corsHeaders);
      }
      if (!conversationId) {
        return jsonResponse({ error: "Missing 'conversationId' field" }, 400, corsHeaders);
      }

      // Validate file type
      const allowedTypes: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
      };
      const ext = allowedTypes[file.type];
      if (!ext) {
        return jsonResponse(
          { error: `Unsupported file type: ${file.type}. Allowed: ${Object.keys(allowedTypes).join(", ")}` },
          400,
          corsHeaders
        );
      }

      // Validate size (5MB max)
      const MAX_SIZE = 5 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        return jsonResponse(
          { error: `File too large: ${file.size} bytes. Max: ${MAX_SIZE} bytes (5MB)` },
          400,
          corsHeaders
        );
      }

      // Upload to Cloudinary (signed upload)
      if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
        return jsonResponse({ error: "Cloudinary not configured on server" }, 500, corsHeaders);
      }

      const resourceType = file.type.startsWith("video/") ? "video" : "image";
      const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;

      // Generate signed upload params
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const folder = `chat/${conversationId}`;
      const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
      const signatureData = new TextEncoder().encode(paramsToSign + env.CLOUDINARY_API_SECRET);
      const hashBuffer = await crypto.subtle.digest("SHA-1", signatureData);
      const signature = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const uploadForm = new FormData();
      uploadForm.append("file", file);
      uploadForm.append("folder", folder);
      uploadForm.append("timestamp", timestamp);
      uploadForm.append("api_key", env.CLOUDINARY_API_KEY);
      uploadForm.append("signature", signature);

      let cloudinaryResult: Record<string, unknown>;
      try {
        const cloudinaryResp = await fetch(cloudinaryUrl, {
          method: "POST",
          body: uploadForm,
        });
        if (!cloudinaryResp.ok) {
          const errText = await cloudinaryResp.text();
          console.error("Cloudinary upload failed:", cloudinaryResp.status, errText);
          return jsonResponse({ error: "Failed to upload to Cloudinary" }, 502, corsHeaders);
        }
        cloudinaryResult = (await cloudinaryResp.json()) as Record<string, unknown>;
      } catch (e) {
        console.error("Cloudinary upload error:", e);
        return jsonResponse({ error: "Failed to upload file" }, 500, corsHeaders);
      }

      const mediaType = resourceType;
      const mediaUrl = (cloudinaryResult.secure_url as string) || (cloudinaryResult.url as string) || "";

      return jsonResponse(
        {
          url: mediaUrl,
          key: (cloudinaryResult.public_id as string) || "",
          type: mediaType,
          mimeType: file.type,
          size: file.size,
          metadata: {
            mediaUrl,
            mediaType,
            mimeType: file.type,
            fileName: file.name || "unknown",
          },
        },
        200,
        corsHeaders
      );
    }

    // ============ TEST: Push Notification ============
    // POST /test-push — send a test push to a specific user
    // Body: { "userId": "...", "title": "...", "body": "..." }
    if (url.pathname === "/test-push" && request.method === "POST") {
      const auth = await getAuth(request, env);
      if (!auth) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let body: { userId: string; title?: string; body?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      const targetUserId = body.userId || auth.userId;
      const title = body.title || "Test Push";
      const pushBody = body.body || "This is a test notification";

      // Check registered devices first
      const routerId = env.NOTIFICATION_ROUTER.idFromName(`user_${targetUserId}`);
      const routerStub = env.NOTIFICATION_ROUTER.get(routerId);

      // Get device list
      const devicesResp = await routerStub.fetch("https://internal/devices", { method: "GET" });
      const devicesData = (await devicesResp.json()) as { devices: Array<{ platform: string; tokenSuffix: string }> };

      if (devicesData.devices.length === 0) {
        return jsonResponse({
          error: "No devices registered for this user",
          userId: targetUserId,
          hint: "Call POST /devices with {platform:'android', token:'fcm_token'} first",
        }, 400, corsHeaders);
      }

      // Send push
      const pushResp = await routerStub.fetch("https://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body: pushBody,
          data: {
            source: "cloudflare-chat",
            type: "message",
            conversationId: "test_push",
            senderId: auth.userId,
          },
        }),
      });
      const pushResult = await pushResp.json();

      return jsonResponse({
        testPush: true,
        targetUserId,
        devices: devicesData.devices,
        pushResult,
      }, 200, corsHeaders);
    }

    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  },
};
