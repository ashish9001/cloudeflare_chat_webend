/**
 * UserSession Durable Object - Phase 3: Presence
 * One instance per user, tracks online/offline/away
 * Tracks active connections across conversations to fix presence race condition.
 * Auto-marks user offline after 15 minutes of no activity via alarm.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, ConversationParticipant } from "./types";

export type PresenceStatus = "online" | "offline" | "away";

const PRESENCE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface PresenceState {
  status: PresenceStatus;
  lastSeen: number;
  source?: string;
  // Track which conversations this user is actively connected to
  activeConnections: Set<string>;
}

// Serializable version for storage
interface StoredPresenceState {
  status: PresenceStatus;
  lastSeen: number;
  source?: string;
  activeConnections: string[]; // serialized as array
}

export class UserSession extends DurableObject<Env> {
  private sql: DurableObjectStorage["sql"];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql;
  }

  private async getPresenceState(): Promise<PresenceState> {
    const stored = (await this.ctx.storage.get("presence")) as StoredPresenceState | undefined;
    if (!stored) {
      return { status: "offline", lastSeen: 0, activeConnections: new Set() };
    }
    return {
      ...stored,
      activeConnections: new Set(stored.activeConnections || []),
    };
  }

  private async savePresenceState(state: PresenceState): Promise<void> {
    const stored: StoredPresenceState = {
      status: state.status,
      lastSeen: state.lastSeen,
      source: state.source,
      activeConnections: [...state.activeConnections],
    };
    await this.ctx.storage.put("presence", stored);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/presence" && request.method === "GET") {
      return this.handleGetPresence();
    }

    if (url.pathname === "/presence" && request.method === "POST") {
      return this.handleSetPresence(url);
    }

    if (url.pathname === "/conversations" && request.method === "GET") {
      return this.handleListConversations(url);
    }

    if (url.pathname === "/conversations/add" && request.method === "POST") {
      return this.handleAddConversation(request);
    }

    if (url.pathname === "/conversations/hide" && request.method === "POST") {
      return this.handleHideConversation(request);
    }

    if (url.pathname === "/conversations/remove" && request.method === "POST") {
      return this.handleRemoveConversation(request);
    }

    if (url.pathname === "/conversations/update-name" && request.method === "POST") {
      return this.handleUpdateConversationName(request);
    }

    if (url.pathname === "/conversations/add-participants" && request.method === "POST") {
      return this.handleAddParticipants(request);
    }

    if (url.pathname === "/conversations/remove-participant" && request.method === "POST") {
      return this.handleRemoveParticipant(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleGetPresence(): Promise<Response> {
    const state = await this.getPresenceState();
    return new Response(
      JSON.stringify({
        status: state.status,
        lastSeen: state.lastSeen,
        activeConversations: state.activeConnections.size,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleSetPresence(url: URL): Promise<Response> {
    const statusParam = url.searchParams.get("status") || "offline";
    const validStatuses: PresenceStatus[] = ["online", "offline", "away"];
    if (!validStatuses.includes(statusParam as PresenceStatus)) {
      return new Response(
        JSON.stringify({ error: `Invalid status '${statusParam}'. Must be one of: online, offline, away` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const requestedStatus = statusParam as PresenceStatus;
    const source = url.searchParams.get("source") || "unknown";
    const action = url.searchParams.get("action") || ""; // connect or disconnect
    const conversationId = url.searchParams.get("conversationId") || "";
    const now = Date.now();

    const state = await this.getPresenceState();

    // Handle connection tracking
    if (action === "connect" && conversationId) {
      state.activeConnections.add(conversationId);
    } else if (action === "disconnect" && conversationId) {
      state.activeConnections.delete(conversationId);
    }

    // Determine actual status based on active connections
    let finalStatus: PresenceStatus;
    if (action === "disconnect" && state.activeConnections.size > 0) {
      // User still has other active connections — stay online
      finalStatus = "online";
    } else if (action === "disconnect" && state.activeConnections.size === 0) {
      // No more active connections — mark offline
      finalStatus = "offline";
    } else {
      finalStatus = requestedStatus;
    }

    state.status = finalStatus;
    state.lastSeen = now;
    state.source = source;

    await this.savePresenceState(state);

    // Schedule auto-offline alarm when user is online or away
    if (finalStatus === "online" || finalStatus === "away") {
      await this.ctx.storage.setAlarm(now + PRESENCE_TIMEOUT_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }

    return new Response(
      JSON.stringify({ ok: true, status: finalStatus, lastSeen: now }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ Conversation Tracking ============

  private ensureConversationSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'dm',
        name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT,
        email TEXT,
        image TEXT,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_conv_id ON conversation_participants(conversation_id);
    `);
    // Schema migration: add per-user soft-delete timestamp for WhatsApp-style hide
    try {
      this.sql.exec("ALTER TABLE conversations ADD COLUMN deleted_at INTEGER DEFAULT NULL");
    } catch { /* column already exists */ }
    // Schema migration: add feature identifier column
    try {
      this.sql.exec("ALTER TABLE conversations ADD COLUMN feature TEXT DEFAULT NULL");
    } catch { /* column already exists */ }
  }

  private async handleListConversations(url: URL): Promise<Response> {
    this.ensureConversationSchema();

    const userId = url.searchParams.get("userId");
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId query param required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const convCursor = this.sql.exec(
      "SELECT conversation_id, type, name, created_at, deleted_at, feature FROM conversations ORDER BY created_at DESC"
    );
    const convRows = convCursor.toArray() as Array<{
      conversation_id: string;
      type: string;
      name: string | null;
      created_at: number;
      deleted_at: number | null;
      feature: string | null;
    }>;

    const conversationResults = await Promise.all(
      convRows.map(async (conv) => {
        const partCursor = this.sql.exec(
          "SELECT user_id, name, email, image FROM conversation_participants WHERE conversation_id = ? ORDER BY user_id ASC",
          conv.conversation_id
        );
        const partRows = partCursor.toArray() as Array<{
          user_id: string;
          name: string | null;
          email: string | null;
          image: string | null;
        }>;

        const participants = partRows.map((p) => ({
          userId: p.user_id,
          name: p.name ?? undefined,
          email: p.email ?? undefined,
          image: p.image ?? undefined,
        }));

        let unreadCount = 0;
        let lastUnreadMessage: {
          id: string;
          senderId: string;
          content: string;
          messageType: string;
          createdAt: number;
          editedAt?: number;
          metadata?: Record<string, unknown>;
        } | null = null;
        let lastMessage: {
          id: string;
          senderId: string;
          content: string;
          messageType: string;
          createdAt: number;
          editedAt?: number;
          metadata?: Record<string, unknown>;
        } | null = null;
        try {
          const chatRoomId = this.env.CHAT_ROOM.idFromName(conv.conversation_id);
          const stub = this.env.CHAT_ROOM.get(chatRoomId);
          const summaryUrl = `https://internal/summary?userId=${encodeURIComponent(userId)}`;
          const res = await stub.fetch(summaryUrl);
          if (res.ok) {
            const data = (await res.json()) as {
              unreadCount?: number;
              lastUnreadMessage?: {
                id: string;
                senderId: string;
                content: string;
                messageType: string;
                createdAt: number;
                editedAt?: number;
                metadata?: Record<string, unknown>;
              } | null;
              lastMessage?: {
                id: string;
                senderId: string;
                content: string;
                messageType: string;
                createdAt: number;
                editedAt?: number;
                metadata?: Record<string, unknown>;
              } | null;
            };
            unreadCount = data.unreadCount ?? 0;
            lastUnreadMessage = data.lastUnreadMessage ?? null;
            lastMessage = data.lastMessage ?? null;
          }
        } catch {
          /* ChatRoom may not be initialized; keep defaults */
        }

        return {
          conversationId: conv.conversation_id,
          type: conv.type,
          name: conv.name ?? undefined,
          feature: conv.feature ?? undefined,
          userIds: partRows.map((p) => p.user_id),
          participants,
          createdAt: conv.created_at,
          unreadCount,
          lastUnreadMessage,
          lastMessage,
          deletedAt: conv.deleted_at ?? undefined,
        };
      })
    );

    const conversations = conversationResults;

    return new Response(JSON.stringify({ conversations }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleAddConversation(request: Request): Promise<Response> {
    let body: {
      conversationId: string;
      type?: string;
      name?: string;
      feature?: string;
      createdAt?: number;
      participants?: ConversationParticipant[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId) {
      return new Response(
        JSON.stringify({ error: "conversationId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    const now = body.createdAt || Date.now();
    // INSERT OR IGNORE: if the conversation row already exists, leave it unchanged.
    // With the unjoin model, unjoining deletes the row entirely (via handleRemoveConversation),
    // so rejoining (via createConversation → handleInit) will INSERT successfully.
    this.sql.exec(
      "INSERT OR IGNORE INTO conversations (conversation_id, type, name, created_at, feature) VALUES (?, ?, ?, ?, ?)",
      body.conversationId,
      body.type || "dm",
      body.name || null,
      now,
      body.feature || null
    );

    if (body.participants && body.participants.length > 0) {
      for (const p of body.participants) {
        this.sql.exec(
          "INSERT OR REPLACE INTO conversation_participants (conversation_id, user_id, name, email, image) VALUES (?, ?, ?, ?, ?)",
          body.conversationId,
          p.userId,
          p.name || null,
          p.email || null,
          p.image || null
        );
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleHideConversation(request: Request): Promise<Response> {
    let body: { conversationId: string; deletedAt: number };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId || !body.deletedAt) {
      return new Response(
        JSON.stringify({ error: "conversationId and deletedAt required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    this.sql.exec(
      "UPDATE conversations SET deleted_at = ? WHERE conversation_id = ?",
      body.deletedAt,
      body.conversationId
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleRemoveConversation(request: Request): Promise<Response> {
    let body: { conversationId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId) {
      return new Response(
        JSON.stringify({ error: "conversationId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    this.sql.exec(
      "DELETE FROM conversation_participants WHERE conversation_id = ?",
      body.conversationId
    );
    this.sql.exec(
      "DELETE FROM conversations WHERE conversation_id = ?",
      body.conversationId
    );

    // Also remove from active connections tracking
    const state = await this.getPresenceState();
    state.activeConnections.delete(body.conversationId);
    await this.savePresenceState(state);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleUpdateConversationName(request: Request): Promise<Response> {
    let body: { conversationId: string; name: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId || body.name === undefined) {
      return new Response(
        JSON.stringify({ error: "conversationId and name required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    this.sql.exec(
      "UPDATE conversations SET name = ? WHERE conversation_id = ?",
      body.name,
      body.conversationId
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleAddParticipants(request: Request): Promise<Response> {
    let body: {
      conversationId: string;
      participants: Array<{ userId: string; name?: string; email?: string; image?: string }>;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId || !body.participants?.length) {
      return new Response(
        JSON.stringify({ error: "conversationId and participants required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    for (const p of body.participants) {
      this.sql.exec(
        "INSERT OR REPLACE INTO conversation_participants (conversation_id, user_id, name, email, image) VALUES (?, ?, ?, ?, ?)",
        body.conversationId,
        p.userId,
        p.name || null,
        p.email || null,
        p.image || null
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleRemoveParticipant(request: Request): Promise<Response> {
    let body: { conversationId: string; userId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.conversationId || !body.userId) {
      return new Response(
        JSON.stringify({ error: "conversationId and userId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureConversationSchema();

    this.sql.exec(
      "DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      body.conversationId,
      body.userId
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Alarm handler: auto-mark user offline if no recent activity.
   * Also clears stale active connections.
   */
  async alarm(): Promise<void> {
    const state = await this.getPresenceState();
    if (state.status === "offline") return;

    const now = Date.now();
    if (now - state.lastSeen >= PRESENCE_TIMEOUT_MS) {
      state.status = "offline";
      state.source = "timeout";
      state.activeConnections.clear();
      await this.savePresenceState(state);
    } else {
      // User had recent activity, reschedule alarm
      const remaining = PRESENCE_TIMEOUT_MS - (now - state.lastSeen);
      await this.ctx.storage.setAlarm(now + remaining);
    }
  }
}
