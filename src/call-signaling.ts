/**
 * CallSignaling Durable Object - Phase 5: Voice/Video signaling
 * One instance per call, relays WebRTC signaling (offer/answer/ICE)
 * Full call lifecycle: initiate, ring, accept, reject, hangup, timeout
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, CallState } from "./types";

const USER_TAG_PREFIX = "user:";
const CALL_RING_TIMEOUT_MS = 30_000; // 30 seconds to answer

interface CallMetadata {
  callId: string;
  callerId: string;
  participants: string[];
  callType: "voice" | "video";
  feature?: string;
  state: CallState;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
}

type SignalingType = "offer" | "answer" | "ice-candidate" | "initiate" | "accept" | "reject" | "hangup";

export class CallSignaling extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(url);
    }

    if (url.pathname === "/ice-servers" && request.method === "GET") {
      return this.handleGetIceServers();
    }

    if (url.pathname === "/initiate" && request.method === "POST") {
      return this.handleInitiateCall(request);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return this.handleGetStatus();
    }

    // REST reject — allows declining a call without a WebSocket connection
    // (e.g. from a notification action before the call activity is launched)
    if (url.pathname === "/reject" && request.method === "POST") {
      return this.handleRestReject(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // ============ REST endpoints ============

  private async handleGetIceServers(): Promise<Response> {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];

    // Always include public STUN
    iceServers.push({ urls: "stun:stun.l.google.com:19302" });
    iceServers.push({ urls: "stun:stun1.l.google.com:19302" });

    // Add TURN server if configured
    if (this.env.TURN_SERVER_URL && this.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:cloudflare-chat`;
      const credential = await this.generateTurnCredential(username);
      iceServers.push({
        urls: this.env.TURN_SERVER_URL,
        username,
        credential,
      });
    }

    return new Response(
      JSON.stringify({ iceServers }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Generate time-limited TURN credential using shared secret (RFC 5766 long-term auth)
   */
  private async generateTurnCredential(username: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.env.TURN_SECRET || ""),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(username)
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  /**
   * Initiate a call via REST (creates call state, sends push to callee)
   */
  private async handleInitiateCall(request: Request): Promise<Response> {
    let body: {
      callId: string;
      callerId: string;
      targetUserIds: string[];
      callType: "voice" | "video";
      callerName?: string;
      callerImage?: string;
      feature?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.callId || !body.callerId || !body.targetUserIds?.length || !body.callType) {
      return new Response(
        JSON.stringify({ error: "callId, callerId, targetUserIds, and callType required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (body.callType !== "voice" && body.callType !== "video") {
      return new Response(
        JSON.stringify({ error: "callType must be 'voice' or 'video'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const metadata: CallMetadata = {
      callId: body.callId,
      callerId: body.callerId,
      participants: [body.callerId, ...body.targetUserIds],
      callType: body.callType,
      feature: body.feature,
      state: "ringing",
      startedAt: now,
    };

    await this.ctx.storage.put("call_metadata", metadata);

    // Set ring timeout alarm
    await this.ctx.storage.setAlarm(now + CALL_RING_TIMEOUT_MS);

    // Send push notification to each target user for incoming call
    const displayName = body.callerName || body.callerId;
    for (const targetUserId of body.targetUserIds) {
      try {
        const stub = this.env.NOTIFICATION_ROUTER.get(
          this.env.NOTIFICATION_ROUTER.idFromName(`user_${targetUserId}`)
        );
        await stub.fetch("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: body.callType === "video" ? "Incoming Video Call" : "Incoming Voice Call",
            body: `Call from ${displayName}`,
            data: {
              source: "cloudflare-chat",
              type: "call_incoming",
              callId: body.callId,
              callerId: body.callerId,
              callerName: displayName,
              callerImage: body.callerImage || "",
              callType: body.callType,
              ...(body.feature ? { feature: body.feature } : {}),
            },
          }),
        });
      } catch (e) {
        console.error(`Failed to send call push to ${targetUserId}:`, e);
      }
    }

    // Notify connected WebSocket clients
    this.broadcastAll({
      type: "call_incoming",
      callId: body.callId,
      callerId: body.callerId,
      callType: body.callType,
    });

    return new Response(
      JSON.stringify({ ok: true, callId: body.callId, state: "ringing" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * REST-based reject — used when declining from a notification without a WS connection.
   */
  private async handleRestReject(request: Request): Promise<Response> {
    let body: { userId: string; reason?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.userId) {
      return new Response(
        JSON.stringify({ error: "userId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    await this.handleRejectCall(body.userId, body.reason);
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleGetStatus(): Promise<Response> {
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (!metadata) {
      return new Response(
        JSON.stringify({ state: "none" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(metadata),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ WebSocket ============

  private async handleWebSocketUpgrade(url: URL): Promise<Response> {
    const userId = url.searchParams.get("userId") || "";
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [`${USER_TAG_PREFIX}${userId}`]);

    // Send current call state on connect
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (metadata) {
      try {
        server.send(JSON.stringify({
          type: "call_status",
          ...metadata,
        }));
      } catch { /* ignore */ }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: { type: string; targetUserId?: string; payload?: unknown; reason?: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.sendError(ws, "INVALID_JSON", "Invalid JSON");
      return;
    }

    if (!msg.type) {
      this.sendError(ws, "MISSING_TYPE", "Message must have a 'type' field");
      return;
    }

    const tags = this.ctx.getTags(ws);
    const userTag = tags.find((t) => t.startsWith(USER_TAG_PREFIX));
    const senderId = userTag ? userTag.slice(USER_TAG_PREFIX.length) : "unknown";

    const signalingType = msg.type as SignalingType;

    switch (signalingType) {
      case "offer":
      case "answer":
      case "ice-candidate":
        this.handleSignalingMessage(ws, senderId, msg);
        break;
      case "accept":
        await this.handleAcceptCall(senderId);
        break;
      case "reject":
        await this.handleRejectCall(senderId, msg.reason);
        break;
      case "hangup":
        await this.handleHangup(senderId);
        break;
      default:
        this.sendError(ws, "UNKNOWN_TYPE", `Unknown signaling type: ${msg.type}`);
    }
  }

  private handleSignalingMessage(
    ws: WebSocket,
    senderId: string,
    msg: { type: string; targetUserId?: string; payload?: unknown }
  ): void {
    const target = msg.targetUserId;
    if (target) {
      this.forwardToUser(target, {
        type: msg.type,
        fromUserId: senderId,
        payload: msg.payload,
      });
    } else {
      this.broadcastExcept(ws, {
        type: msg.type,
        fromUserId: senderId,
        payload: msg.payload,
      });
    }
  }

  private async handleAcceptCall(userId: string): Promise<void> {
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (!metadata || metadata.state !== "ringing") {
      return;
    }

    metadata.state = "active";
    metadata.answeredAt = Date.now();
    await this.ctx.storage.put("call_metadata", metadata);

    // Cancel ring timeout
    await this.ctx.storage.deleteAlarm();

    this.broadcastAll({
      type: "call_accepted",
      callId: metadata.callId,
      userId,
    });

    // Send push notification to all participants except the accepter
    // so their devices can dismiss the incoming call notification
    for (const participantId of metadata.participants) {
      if (participantId === userId) continue;
      try {
        const stub = this.env.NOTIFICATION_ROUTER.get(
          this.env.NOTIFICATION_ROUTER.idFromName(`user_${participantId}`)
        );
        await stub.fetch("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Call Accepted",
            body: "Call was answered",
            data: {
              source: "cloudflare-chat",
              type: "call_accepted",
              callId: metadata.callId,
              userId,
              ...(metadata.feature ? { feature: metadata.feature } : {}),
            },
          }),
        });
      } catch (e) {
        console.error(`Failed to send call_accepted push to ${participantId}:`, e);
      }
    }
  }

  private async handleRejectCall(userId: string, reason?: string): Promise<void> {
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (!metadata || metadata.state === "ended") {
      return;
    }

    this.broadcastAll({
      type: "call_rejected",
      callId: metadata.callId,
      userId,
      reason: reason || "declined",
    });

    // Send push notification to caller about the rejection
    // (so their device gets notified even if WS is disconnected)
    try {
      const stub = this.env.NOTIFICATION_ROUTER.get(
        this.env.NOTIFICATION_ROUTER.idFromName(`user_${metadata.callerId}`)
      );
      await stub.fetch("https://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Call Declined",
          body: "Call was declined",
          data: {
            source: "cloudflare-chat",
            type: "call_rejected",
            callId: metadata.callId,
            userId,
            reason: reason || "declined",
            ...(metadata.feature ? { feature: metadata.feature } : {}),
          },
        }),
      });
    } catch (e) {
      console.error(`Failed to send call_rejected push to caller ${metadata.callerId}:`, e);
    }

    // If all non-caller participants rejected, end the call
    const nonCallerParticipants = metadata.participants.filter((p) => p !== metadata.callerId);
    // For 1:1 calls, one rejection ends it
    if (nonCallerParticipants.length <= 1) {
      await this.endCall(userId, "declined");
    }
  }

  private async handleHangup(userId: string): Promise<void> {
    await this.endCall(userId, "hangup");
  }

  private async endCall(endedBy: string, reason: "hangup" | "timeout" | "declined" | "error"): Promise<void> {
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (!metadata || metadata.state === "ended") return;

    metadata.state = "ended";
    metadata.endedAt = Date.now();
    await this.ctx.storage.put("call_metadata", metadata);

    await this.ctx.storage.deleteAlarm();

    this.broadcastAll({
      type: "call_ended",
      callId: metadata.callId,
      endedBy,
      reason,
    });

    // Send push notification to dismiss incoming call notifications on offline devices
    for (const userId of metadata.participants) {
      if (userId === endedBy) continue; // caller already knows
      try {
        const stub = this.env.NOTIFICATION_ROUTER.get(
          this.env.NOTIFICATION_ROUTER.idFromName(`user_${userId}`)
        );
        await stub.fetch("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Call Ended",
            body: `Call ended: ${reason}`,
            data: {
              source: "cloudflare-chat",
              type: "call_ended",
              callId: metadata.callId,
              endedBy,
              reason,
              ...(metadata.feature ? { feature: metadata.feature } : {}),
            },
          }),
        });
      } catch (e) {
        console.error(`Failed to send call_ended push to ${userId}:`, e);
      }
    }

    // Schedule alarm to close WebSocket connections after 1 second
    // (setTimeout is unreliable in Durable Object Hibernation API)
    await this.ctx.storage.put("pending_close", true);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /**
   * Alarm handler: call ring timeout OR deferred WebSocket close after call end.
   */
  async alarm(): Promise<void> {
    // Check if this alarm is for closing WebSockets after call ended
    const pendingClose = await this.ctx.storage.get("pending_close");
    if (pendingClose) {
      await this.ctx.storage.delete("pending_close");
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "Call ended");
        } catch { /* already closed */ }
      }
      return;
    }

    // Otherwise handle ring timeout
    const metadata = (await this.ctx.storage.get("call_metadata")) as CallMetadata | undefined;
    if (!metadata) return;

    if (metadata.state === "ringing") {
      await this.endCall("system", "timeout");
    }
  }

  // ============ Helpers ============

  private sendError(ws: WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: "error", code, message }));
    } catch (e) {
      console.error("CallSignaling sendError failed:", e);
    }
  }

  private forwardToUser(targetUserId: string, msg: unknown): void {
    const str = JSON.stringify(msg);
    const targetTag = `${USER_TAG_PREFIX}${targetUserId}`;
    for (const ws of this.ctx.getWebSockets(targetTag)) {
      try {
        ws.send(str);
      } catch (e) {
        console.error("CallSignaling forwardToUser failed:", e);
      }
    }
  }

  private broadcastExcept(exclude: WebSocket, msg: unknown): void {
    const str = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach((w) => {
      if (w !== exclude) {
        try {
          w.send(str);
        } catch (e) {
          console.error("CallSignaling broadcastExcept failed:", e);
        }
      }
    });
  }

  private broadcastAll(msg: unknown): void {
    const str = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach((w) => {
      try {
        w.send(str);
      } catch (e) {
        console.error("CallSignaling broadcastAll failed:", e);
      }
    });
  }
}
