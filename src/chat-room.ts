/**
 * ChatRoom Durable Object
 * Phase 1-2: 1:1 chat, group chat, history, read/unread, edit/delete
 * One instance per conversation (dm or group)
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ConversationParticipant,
  Env,
  MessagePayload,
  ServerMessage,
} from "./types";

const USER_TAG_PREFIX = "user:";
const MAX_MESSAGE_LENGTH = 4096; // 4KB max message content
const MAX_METADATA_SIZE = 2048; // 2KB max metadata JSON
const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const RATE_LIMIT_MAX_MESSAGES = 10; // max 10 messages per window
const TYPING_TIMEOUT_MS = 5_000; // 5 seconds typing indicator timeout
const MAX_SEND_FAILURES = 3; // close WS after this many consecutive failures
const MAX_GROUP_MEMBERS = 256; // max members in a group conversation

export class ChatRoom extends DurableObject<Env> {
  private sql: DurableObjectStorage["sql"];
  // Rate limiting: userId -> array of timestamps
  private rateLimitMap = new Map<string, number[]>();
  // Typing state: userId -> expiry timestamp (ms). Avoids setTimeout which is
  // unreliable under the Durable Object Hibernation API.
  private typingExpiry = new Map<string, number>();
  // Track consecutive send failures per WebSocket
  private sendFailures = new WeakMap<WebSocket, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/init" && request.method === "POST") {
        return await this.handleInit(request);
      }

      if (url.pathname === "/history" && request.method === "GET") {
        return this.handleGetHistory(url);
      }

      if (url.pathname === "/summary" && request.method === "GET") {
        return this.handleGetSummary(url);
      }

      if (url.pathname === "/members" && request.method === "GET") {
        return this.handleListMembers();
      }

      if (url.pathname === "/members/add" && request.method === "POST") {
        return await this.handleAddMembers(request);
      }

      if (url.pathname === "/members/remove" && request.method === "POST") {
        return await this.handleRemoveMembers(request);
      }

      if (url.pathname === "/leave" && request.method === "POST") {
        return await this.handleLeave(request);
      }

      if (url.pathname === "/update" && request.method === "POST") {
        return await this.handleUpdateConversation(request);
      }

      if (url.pathname === "/members/role" && request.method === "POST") {
        return await this.handleChangeRole(request);
      }

      if (url.pathname === "/delete" && request.method === "POST") {
        return await this.handleDeleteConversation(request);
      }

      if (url.pathname === "/hide-for-user" && request.method === "POST") {
        return await this.handleHideForUser(request);
      }

      if (url.pathname === "/mute" && request.method === "POST") {
        return await this.handleMute(request, true);
      }

      if (url.pathname === "/unmute" && request.method === "POST") {
        return await this.handleMute(request, false);
      }

      // Notify endpoint for push — called by worker to send push to all members
      if (url.pathname === "/notify" && request.method === "POST") {
        return await this.handleNotifyAll(request);
      }

      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return await this.handleWebSocketUpgrade(url);
      }
    } catch (e) {
      console.error("ChatRoom.fetch error:", e);
      return new Response(
        JSON.stringify({
          error: "Internal error",
          detail: e instanceof Error ? e.message : "Unknown error",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleInit(request: Request): Promise<Response> {
    let body: {
      conversationId: string;
      creatorId: string;
      memberIds: string[];
      type?: string;
      name?: string;
      feature?: string;
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

    if (!body.conversationId || !body.creatorId || !Array.isArray(body.memberIds) || body.memberIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: conversationId, creatorId, memberIds" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    const now = Date.now();
    // Use client-provided type if given; fall back to member-count heuristic for backward compat
    const convType = body.type === "group" ? "group" : (body.type === "dm" ? "dm" : (body.memberIds.length > 2 ? "group" : "dm"));

    // Enforce group size limit
    if (convType === "group" && body.memberIds.length > MAX_GROUP_MEMBERS) {
      return new Response(
        JSON.stringify({ error: `Group cannot exceed ${MAX_GROUP_MEMBERS} members` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    for (const userId of body.memberIds) {
      const role = userId === body.creatorId ? "admin" : "member";
      this.sql.exec(
        "INSERT OR IGNORE INTO members (user_id, role, joined_at, last_read_index) VALUES (?, ?, ?, ?)",
        userId,
        role,
        now,
        0
      );
    }

    await this.ctx.storage.put("conversation_name", body.name || "");
    await this.ctx.storage.put("conversation_type", convType);
    await this.ctx.storage.put("conversation_id", body.conversationId);
    if (body.feature) {
      await this.ctx.storage.put("conversation_feature", body.feature);
    }

    // Register this conversation in each member's UserSession.
    // INSERT OR IGNORE in UserSession.handleAddConversation re-adds the conversation
    // if the user had previously unjoined (row was deleted).
    for (const userId of body.memberIds) {
      try {
        const userSessionId = this.env.USER_SESSION.idFromName(`user_${userId}`);
        const stub = this.env.USER_SESSION.get(userSessionId);
        await stub.fetch("https://internal/conversations/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: body.conversationId,
            type: convType,
            name: body.name,
            feature: body.feature,
            createdAt: now,
            participants: body.participants || body.memberIds.map((id) => ({ userId: id })),
          }),
        });
      } catch (e) {
        console.error(`Failed to register conversation in UserSession for ${userId}:`, e);
      }
    }

    return new Response(
      JSON.stringify({
        conversationId: body.conversationId,
        createdAt: now,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE TABLE IF NOT EXISTS members (
        user_id TEXT PRIMARY KEY,
        role TEXT DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        last_read_index INTEGER DEFAULT 0
      );
    `);
    // Schema migration: add per-user soft-delete timestamp for WhatsApp-style hide
    try {
      this.sql.exec("ALTER TABLE members ADD COLUMN deleted_at INTEGER DEFAULT NULL");
    } catch { /* column already exists */ }
    // Schema migration: add temp_id column for client-side deduplication
    try {
      this.sql.exec("ALTER TABLE messages ADD COLUMN temp_id TEXT DEFAULT NULL");
    } catch { /* column already exists */ }
    // Schema migration: add reply_to_id column for threaded replies
    try {
      this.sql.exec("ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL");
    } catch { /* column already exists */ }
    // Reactions table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `);
    // Schema migration: add muted column for per-user notification mute
    try {
      this.sql.exec("ALTER TABLE members ADD COLUMN muted INTEGER DEFAULT 0");
    } catch { /* column already exists */ }
  }

  /**
   * Check if a user is a member of this conversation.
   */
  private isMember(userId: string): boolean {
    try {
      const row = this.sql
        .exec("SELECT user_id FROM members WHERE user_id = ?", userId)
        .one();
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Get reactions for a list of message IDs, grouped by message.
   */
  private getReactionsForMessages(messageIds: string[]): Map<string, Array<{ userId: string; emoji: string }>> {
    const result = new Map<string, Array<{ userId: string; emoji: string }>>();
    if (messageIds.length === 0) return result;
    // SQLite IN clause with placeholders
    const placeholders = messageIds.map(() => "?").join(",");
    try {
      const rows = this.sql
        .exec(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders})`, ...messageIds)
        .toArray() as Array<{ message_id: string; user_id: string; emoji: string }>;
      for (const row of rows) {
        const arr = result.get(row.message_id) || [];
        arr.push({ userId: row.user_id, emoji: row.emoji });
        result.set(row.message_id, arr);
      }
    } catch { /* reactions table may not exist yet */ }
    return result;
  }

  /**
   * Get the role of a member (admin/member).
   */
  private getMemberRole(userId: string): string | null {
    try {
      const row = this.sql
        .exec("SELECT role FROM members WHERE user_id = ?", userId)
        .one() as { role: string } | undefined;
      return row?.role ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Simple rate limiting: returns true if the user is rate-limited.
   */
  private isRateLimited(userId: string): boolean {
    const now = Date.now();
    let timestamps = this.rateLimitMap.get(userId) || [];

    // Remove timestamps outside the window
    timestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      this.rateLimitMap.set(userId, timestamps);
      return true;
    }

    timestamps.push(now);
    this.rateLimitMap.set(userId, timestamps);
    return false;
  }

  /**
   * Validate metadata size
   */
  private isValidMetadata(metadata: unknown): boolean {
    if (metadata === undefined || metadata === null) return true;
    if (typeof metadata !== "object") return false;
    const str = JSON.stringify(metadata);
    return str.length <= MAX_METADATA_SIZE;
  }

  private handleGetHistory(url: URL): Response {
    this.ensureSchema();

    const before = url.searchParams.get("before");
    const limitStr = url.searchParams.get("limit") || "50";
    const parsedLimit = parseInt(limitStr, 10);
    const limit = Math.min(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 100);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Membership check for history access
    if (!this.isMember(userId)) {
      return new Response(
        JSON.stringify({ error: "Not a member of this conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    let query =
      "SELECT id, sender_id, content, message_type, created_at, edited_at, metadata, reply_to_id FROM messages WHERE deleted_at IS NULL";
    const params: (string | number)[] = [];

    // Per-user soft delete: only show messages after user's deleted_at cutoff
    const memberDeletedAt = this.getMemberDeletedAt(userId);
    if (memberDeletedAt !== null) {
      query += " AND created_at > ?";
      params.push(memberDeletedAt);
    }

    if (before) {
      let beforeTs: number;
      // Support both message ID format (msg_{timestamp}_{uuid}) and raw timestamp
      if (before.startsWith("msg_")) {
        const parts = before.split("_");
        beforeTs = parseInt(parts[1], 10);
      } else {
        beforeTs = parseInt(before, 10);
      }
      if (!Number.isNaN(beforeTs)) {
        query += " AND created_at < ?";
        params.push(beforeTs);
      }
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const cursor = this.sql.exec(query, ...params);
    const results = cursor.toArray() as Array<{
      id: string;
      sender_id: string;
      content: string;
      message_type: string;
      created_at: number;
      edited_at: number | null;
      metadata: string | null;
      reply_to_id: string | null;
    }>;

    // Batch-fetch reactions for all messages
    const messageIds = results.map((r) => r.id);
    const reactionsMap = this.getReactionsForMessages(messageIds);

    const messages: MessagePayload[] = [...results].reverse().map((r) => ({
      type: "message",
      id: r.id,
      senderId: r.sender_id,
      content: r.content,
      messageType: r.message_type,
      createdAt: r.created_at,
      editedAt: r.edited_at ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      replyToId: r.reply_to_id ?? undefined,
      reactions: reactionsMap.get(r.id) || undefined,
    }));

    let lastReadIndex = 0;
    try {
      const lastReadRow = this.sql
        .exec(
          "SELECT last_read_index FROM members WHERE user_id = ?",
          userId
        )
        .one() as { last_read_index: number };
      lastReadIndex = lastReadRow.last_read_index;
    } catch {
      /* user may not be in members yet */
    }

    return new Response(JSON.stringify({ messages, lastReadIndex }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Lightweight summary for unread count: returns messageCount, lastReadIndex, unreadCount, lastUnreadMessage.
   * Unread = max(0, messageCount - lastReadIndex - 1).
   */
  private handleGetSummary(url: URL): Response {
    this.ensureSchema();

    const userId = url.searchParams.get("userId");
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!this.isMember(userId)) {
      return new Response(
        JSON.stringify({ error: "Not a member of this conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Per-user soft delete: only count messages after user's deleted_at cutoff
    const memberDeletedAt = this.getMemberDeletedAt(userId);

    // lastReadIndex is a Unix ms timestamp (from mark_read), NOT a positional index.
    // Count unread messages = messages created AFTER the user's last-read timestamp.
    let lastReadIndex = 0;
    try {
      const lrRow = this.sql
        .exec(
          "SELECT last_read_index FROM members WHERE user_id = ?",
          userId
        )
        .one() as { last_read_index: number };
      lastReadIndex = lrRow?.last_read_index ?? 0;
    } catch {
      /* user may not be in members yet */
    }

    // Total message count (for messageCount field in response)
    let totalCountQuery = "SELECT COUNT(*) as cnt FROM messages WHERE deleted_at IS NULL";
    const totalCountParams: (string | number)[] = [];
    if (memberDeletedAt !== null) {
      totalCountQuery += " AND created_at > ?";
      totalCountParams.push(memberDeletedAt);
    }
    const totalCountCursor = this.sql.exec(totalCountQuery, ...totalCountParams);
    const messageCount = (totalCountCursor.one() as { cnt: number })?.cnt ?? 0;

    // Unread count: messages created after the user's last-read timestamp
    let unreadQuery = "SELECT COUNT(*) as cnt FROM messages WHERE deleted_at IS NULL AND created_at > ?";
    const unreadParams: (string | number)[] = [lastReadIndex];
    if (memberDeletedAt !== null) {
      unreadQuery += " AND created_at > ?";
      unreadParams.push(memberDeletedAt);
    }
    const unreadCursor = this.sql.exec(unreadQuery, ...unreadParams);
    const unreadCount = (unreadCursor.one() as { cnt: number })?.cnt ?? 0;

    let lastUnreadMessage: MessagePayload | null = null;
    if (unreadCount > 0) {
      let lastMsgQuery = "SELECT id, sender_id, content, message_type, created_at, edited_at, metadata, reply_to_id FROM messages WHERE deleted_at IS NULL AND created_at > ?";
      const lastMsgParams: (string | number)[] = [lastReadIndex];
      if (memberDeletedAt !== null) {
        lastMsgQuery += " AND created_at > ?";
        lastMsgParams.push(memberDeletedAt);
      }
      lastMsgQuery += " ORDER BY created_at DESC LIMIT 1";
      const lastMsgCursor = this.sql.exec(lastMsgQuery, ...lastMsgParams);
      const row = lastMsgCursor.one() as {
        id: string;
        sender_id: string;
        content: string;
        message_type: string;
        created_at: number;
        edited_at: number | null;
        metadata: string | null;
        reply_to_id: string | null;
      } | null;
      if (row) {
        lastUnreadMessage = {
          type: "message",
          id: row.id,
          senderId: row.sender_id,
          content: row.content,
          messageType: row.message_type,
          createdAt: row.created_at,
          editedAt: row.edited_at ?? undefined,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          replyToId: row.reply_to_id ?? undefined,
        };
      }
    }

    // Always return the most recent message for preview (regardless of read status)
    let lastMessage: MessagePayload | null = null;
    {
      let lmQuery = "SELECT id, sender_id, content, message_type, created_at, edited_at, metadata, reply_to_id FROM messages WHERE deleted_at IS NULL";
      const lmParams: (string | number)[] = [];
      if (memberDeletedAt !== null) {
        lmQuery += " AND created_at > ?";
        lmParams.push(memberDeletedAt);
      }
      lmQuery += " ORDER BY created_at DESC LIMIT 1";
      const lmCursor = this.sql.exec(lmQuery, ...lmParams);
      const lmRow = lmCursor.one() as {
        id: string;
        sender_id: string;
        content: string;
        message_type: string;
        created_at: number;
        edited_at: number | null;
        metadata: string | null;
        reply_to_id: string | null;
      } | null;
      if (lmRow) {
        lastMessage = {
          type: "message",
          id: lmRow.id,
          senderId: lmRow.sender_id,
          content: lmRow.content,
          messageType: lmRow.message_type,
          createdAt: lmRow.created_at,
          editedAt: lmRow.edited_at ?? undefined,
          metadata: lmRow.metadata ? JSON.parse(lmRow.metadata) : undefined,
          replyToId: lmRow.reply_to_id ?? undefined,
        };
      }
    }

    // If user has hidden this conversation and there are no visible messages, flag as hidden
    const hidden = memberDeletedAt !== null && messageCount === 0;

    return new Response(
      JSON.stringify({
        messageCount,
        lastReadIndex,
        unreadCount,
        lastUnreadMessage,
        lastMessage,
        hidden,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ Group Management ============

  private handleListMembers(): Response {
    this.ensureSchema();
    const cursor = this.sql.exec(
      "SELECT user_id, role, joined_at, last_read_index FROM members ORDER BY joined_at ASC"
    );
    const members = cursor.toArray() as Array<{
      user_id: string;
      role: string;
      joined_at: number;
      last_read_index: number;
    }>;

    return new Response(
      JSON.stringify({
        members: members.map((m) => ({
          userId: m.user_id,
          role: m.role,
          joinedAt: m.joined_at,
          lastReadIndex: m.last_read_index ?? 0,
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleAddMembers(request: Request): Promise<Response> {
    let body: {
      requesterId: string;
      userIds: string[];
      conversationId: string;
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

    this.ensureSchema();

    // Only admins can add members
    const role = this.getMemberRole(body.requesterId);
    if (role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Only admins can add members" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const convType = await this.ctx.storage.get("conversation_type");
    if (convType !== "group") {
      return new Response(
        JSON.stringify({ error: "Cannot add members to a DM" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Enforce group size limit — only count genuinely new (non-member) users
    const currentCount = (this.sql
      .exec("SELECT COUNT(*) as cnt FROM members")
      .one() as { cnt: number }).cnt;
    const newUserIds = body.userIds.filter(uid => !this.getMemberRole(uid));
    if (currentCount + newUserIds.length > MAX_GROUP_MEMBERS) {
      return new Response(
        JSON.stringify({ error: `Group cannot exceed ${MAX_GROUP_MEMBERS} members. Current: ${currentCount}, adding: ${newUserIds.length}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const added: string[] = [];

    for (const userId of body.userIds) {
      if (!this.isMember(userId)) {
        this.sql.exec(
          "INSERT INTO members (user_id, role, joined_at, last_read_index) VALUES (?, ?, ?, ?)",
          userId,
          "member",
          now,
          0
        );
        added.push(userId);

        // Register conversation in their UserSession
        try {
          const stub = this.env.USER_SESSION.get(
            this.env.USER_SESSION.idFromName(`user_${userId}`)
          );
          const convName = await this.ctx.storage.get("conversation_name");
          await stub.fetch("https://internal/conversations/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: body.conversationId,
              type: "group",
              name: convName,
              createdAt: now,
              participants: body.participants || [{ userId }],
            }),
          });
        } catch (e) {
          console.error(`Failed to register conversation for new member ${userId}:`, e);
        }

        // Broadcast member added to existing connections
        this.broadcast({
          type: "member_added",
          userId,
          addedBy: body.requesterId,
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, added }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleRemoveMembers(request: Request): Promise<Response> {
    let body: {
      requesterId: string;
      userIds: string[];
      conversationId: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    // Cannot remove members from a DM
    const convType = await this.ctx.storage.get("conversation_type");
    if (convType !== "group") {
      return new Response(
        JSON.stringify({ error: "Cannot remove members from a DM" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const role = this.getMemberRole(body.requesterId);
    if (role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Only admins can remove members" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const removed: string[] = [];
    for (const userId of body.userIds) {
      // Cannot remove yourself via this endpoint (use /leave)
      if (userId === body.requesterId) continue;

      if (this.isMember(userId)) {
        this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);
        removed.push(userId);

        // Remove conversation from their UserSession
        try {
          const stub = this.env.USER_SESSION.get(
            this.env.USER_SESSION.idFromName(`user_${userId}`)
          );
          await stub.fetch("https://internal/conversations/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: body.conversationId }),
          });
        } catch (e) {
          console.error(`Failed to remove conversation from UserSession for ${userId}:`, e);
        }

        // Close their WebSocket connections
        const tag = `${USER_TAG_PREFIX}${userId}`;
        for (const ws of this.ctx.getWebSockets(tag)) {
          try {
            ws.close(4003, "Removed from conversation");
          } catch { /* already closed */ }
        }

        this.broadcast({
          type: "member_removed",
          userId,
          removedBy: body.requesterId,
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, removed }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleLeave(request: Request): Promise<Response> {
    let body: { userId: string; conversationId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    if (!this.isMember(body.userId)) {
      return new Response(
        JSON.stringify({ error: "Not a member" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const convType = await this.ctx.storage.get("conversation_type");
    if (convType !== "group") {
      return new Response(
        JSON.stringify({ error: "Cannot leave a DM" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // If the leaver is the last admin, auto-promote the oldest remaining member
    const leaverRole = this.getMemberRole(body.userId);
    if (leaverRole === "admin") {
      const adminCount = (this.sql
        .exec("SELECT COUNT(*) as cnt FROM members WHERE role = 'admin'")
        .one() as { cnt: number }).cnt;

      if (adminCount === 1) {
        // Last admin leaving — promote oldest non-admin member
        const nextAdmin = this.sql
          .exec(
            "SELECT user_id FROM members WHERE user_id != ? ORDER BY joined_at ASC LIMIT 1",
            body.userId
          )
          .toArray() as Array<{ user_id: string }>;

        if (nextAdmin.length > 0) {
          this.sql.exec(
            "UPDATE members SET role = 'admin' WHERE user_id = ?",
            nextAdmin[0].user_id
          );
          // Notify group about the new admin
          this.broadcast({
            type: "role_changed",
            userId: nextAdmin[0].user_id,
            newRole: "admin",
            changedBy: "system",
          });
        }
      }
    }

    this.sql.exec("DELETE FROM members WHERE user_id = ?", body.userId);

    // Remove from UserSession
    try {
      const stub = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(`user_${body.userId}`)
      );
      await stub.fetch("https://internal/conversations/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: body.conversationId }),
      });
    } catch (e) {
      console.error(`Failed to remove conversation from UserSession for ${body.userId}:`, e);
    }

    // Close their WebSocket connections
    const tag = `${USER_TAG_PREFIX}${body.userId}`;
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.close(4004, "Left conversation");
      } catch { /* already closed */ }
    }

    this.broadcast({
      type: "member_removed",
      userId: body.userId,
      removedBy: body.userId,
    });

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleUpdateConversation(request: Request): Promise<Response> {
    let body: { requesterId: string; name?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    const role = this.getMemberRole(body.requesterId);
    if (role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Only admins can update conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (body.name !== undefined) {
      const trimmedName = typeof body.name === "string" ? body.name.trim() : "";
      if (trimmedName.length === 0) {
        return new Response(
          JSON.stringify({ error: "Group name cannot be empty" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await this.ctx.storage.put("conversation_name", trimmedName);
      // Broadcast name change to all connected members
      this.broadcast({
        type: "conversation_updated",
        name: trimmedName,
        updatedBy: body.requesterId,
      });
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleChangeRole(request: Request): Promise<Response> {
    let body: { requesterId: string; userId: string; role: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    // Only admins can change roles
    const requesterRole = this.getMemberRole(body.requesterId);
    if (requesterRole !== "admin") {
      return new Response(
        JSON.stringify({ error: "Only admins can change member roles" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Only works on group conversations
    const convType = await this.ctx.storage.get("conversation_type");
    if (convType !== "group") {
      return new Response(
        JSON.stringify({ error: "Cannot change roles in a DM" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate role
    if (body.role !== "admin" && body.role !== "member") {
      return new Response(
        JSON.stringify({ error: "Role must be 'admin' or 'member'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Target must be a member
    if (!this.isMember(body.userId)) {
      return new Response(
        JSON.stringify({ error: "Target user is not a member" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Prevent demoting the last admin
    if (body.role === "member") {
      const currentRole = this.getMemberRole(body.userId);
      if (currentRole === "admin") {
        const adminCount = (this.sql
          .exec("SELECT COUNT(*) as cnt FROM members WHERE role = 'admin'")
          .one() as { cnt: number }).cnt;
        if (adminCount <= 1) {
          return new Response(
            JSON.stringify({ error: "Cannot demote the last admin. Promote another member first." }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    this.sql.exec("UPDATE members SET role = ? WHERE user_id = ?", body.role, body.userId);

    this.broadcast({
      type: "role_changed",
      userId: body.userId,
      newRole: body.role as "admin" | "member",
      changedBy: body.requesterId,
    });

    return new Response(
      JSON.stringify({ ok: true, userId: body.userId, newRole: body.role }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleDeleteConversation(request: Request): Promise<Response> {
    let body: { requesterId: string; conversationId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    // Only admins (or DM members) can delete
    const role = this.getMemberRole(body.requesterId);
    if (!role) {
      return new Response(
        JSON.stringify({ error: "Not a member of this conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const convType = await this.ctx.storage.get("conversation_type");
    if (convType === "group" && role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Only admins can delete a group conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get all members before deleting
    const allMembers = this.sql
      .exec("SELECT user_id FROM members")
      .toArray() as Array<{ user_id: string }>;

    // Delete all messages and members from SQLite
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM members");

    // Clear stored metadata
    await this.ctx.storage.delete("conversation_name");
    await this.ctx.storage.delete("conversation_type");
    await this.ctx.storage.delete("conversation_id");

    // Remove conversation from every member's UserSession
    for (const member of allMembers) {
      try {
        const stub = this.env.USER_SESSION.get(
          this.env.USER_SESSION.idFromName(`user_${member.user_id}`)
        );
        await stub.fetch("https://internal/conversations/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: body.conversationId }),
        });
      } catch (e) {
        console.error(`Failed to remove conversation from UserSession for ${member.user_id}:`, e);
      }
    }

    // Close all active WebSocket connections
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4005, "Conversation deleted");
      } catch { /* already closed */ }
    }

    return new Response(
      JSON.stringify({ ok: true, deletedFor: allMembers.map((m) => m.user_id) }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ Unjoin (swipe-to-delete removes member from conversation) ============

  private async handleHideForUser(request: Request): Promise<Response> {
    let body: { userId: string };
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

    this.ensureSchema();

    // Remove the member row entirely (unjoin).
    // When they send a message again, createConversation → handleInit
    // re-inserts them via INSERT OR IGNORE.
    this.sql.exec("DELETE FROM members WHERE user_id = ?", body.userId);

    // Close any active WebSocket connections for this user
    const userTag = `${USER_TAG_PREFIX}${body.userId}`;
    for (const ws of this.ctx.getWebSockets(userTag)) {
      try {
        ws.close(4004, "Left conversation");
      } catch { /* already closed */ }
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Look up the per-user deleted_at timestamp from the members table.
   * Returns null if not set (user has not hidden this conversation).
   */
  private getMemberDeletedAt(userId: string): number | null {
    try {
      const row = this.sql
        .exec("SELECT deleted_at FROM members WHERE user_id = ?", userId)
        .one() as { deleted_at: number | null } | undefined;
      return row?.deleted_at ?? null;
    } catch {
      return null;
    }
  }

  // ============ Mute/Unmute ============

  private async handleMute(request: Request, mute: boolean): Promise<Response> {
    let body: { userId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    if (!this.isMember(body.userId)) {
      return new Response(
        JSON.stringify({ error: "Not a member" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    this.sql.exec(
      "UPDATE members SET muted = ? WHERE user_id = ?",
      mute ? 1 : 0,
      body.userId
    );

    return new Response(
      JSON.stringify({ ok: true, muted: mute }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ Push notifications for all members ============

  private async handleNotifyAll(request: Request): Promise<Response> {
    let body: { senderId: string; content: string; conversationId: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.ensureSchema();

    const feature = (await this.ctx.storage.get("conversation_feature")) as string | undefined;

    const allMembers = this.sql
      .exec("SELECT user_id, muted FROM members")
      .toArray() as Array<{ user_id: string; muted: number }>;

    const mutedUserIds = new Set(
      allMembers.filter((m) => m.muted === 1).map((m) => m.user_id)
    );

    // Push to ALL members except sender and muted users (regardless of WebSocket connection status)
    const targetMembers = allMembers
      .map((m) => m.user_id)
      .filter((id) => id !== body.senderId && !mutedUserIds.has(id));

    console.log(`[PUSH] sendPushNotifications: sender=${body.senderId} targetMembers=[${targetMembers.join(',')}] allMembers=[${allMembers.map(m => m.user_id).join(',')}]`);
    for (const userId of targetMembers) {
      try {
        const stub = this.env.NOTIFICATION_ROUTER.get(
          this.env.NOTIFICATION_ROUTER.idFromName(`user_${userId}`)
        );
        await stub.fetch("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "New message",
            body: body.content.length > 100
              ? body.content.slice(0, 100) + "..."
              : body.content,
            data: {
              source: "cloudflare-chat",
              type: "message",
              conversationId: body.conversationId,
              senderId: body.senderId,
              ...(feature ? { feature } : {}),
            },
          }),
        });
      } catch (e) {
        console.error(`Failed to send push to ${userId}:`, e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, notified: targetMembers.length }),
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

    this.ensureSchema();

    // Membership check: only allow members to connect
    if (!this.isMember(userId)) {
      return new Response(
        JSON.stringify({ error: "Not a member of this conversation" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [`${USER_TAG_PREFIX}${userId}`]);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );

    // Notify UserSession — increment connection count
    const conversationId = (await this.ctx.storage.get("conversation_id")) as string || "";
    try {
      const stub = this.env.USER_SESSION.get(
        this.env.USER_SESSION.idFromName(`user_${userId}`)
      );
      await stub.fetch(
        `https://internal/presence?status=online&source=chat&action=connect&conversationId=${encodeURIComponent(conversationId)}`,
        { method: "POST" }
      );
    } catch (e) {
      console.error("Failed to update presence on connect:", e);
    }

    // Sync recent messages (respecting per-user soft delete cutoff)
    try {
      const memberDeletedAt = this.getMemberDeletedAt(userId);
      let syncQuery = "SELECT id, sender_id, content, message_type, created_at, edited_at, metadata, reply_to_id FROM messages WHERE deleted_at IS NULL";
      const syncParams: (string | number)[] = [];
      if (memberDeletedAt !== null) {
        syncQuery += " AND created_at > ?";
        syncParams.push(memberDeletedAt);
      }
      syncQuery += " ORDER BY created_at DESC LIMIT 50";
      const recentCursor = this.sql.exec(syncQuery, ...syncParams);
      const recent = recentCursor.toArray() as Array<{
        id: string;
        sender_id: string;
        content: string;
        message_type: string;
        created_at: number;
        edited_at: number | null;
        metadata: string | null;
        reply_to_id: string | null;
      }>;

      // Batch-fetch reactions for sync messages
      const syncMsgIds = recent.map((r) => r.id);
      const syncReactions = this.getReactionsForMessages(syncMsgIds);

      const syncMessages: MessagePayload[] = [...recent]
        .reverse()
        .map((r) => ({
          type: "message" as const,
          id: r.id,
          senderId: r.sender_id,
          content: r.content,
          messageType: r.message_type,
          createdAt: r.created_at,
          editedAt: r.edited_at ?? undefined,
          metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
          replyToId: r.reply_to_id ?? undefined,
          reactions: syncReactions.get(r.id) || undefined,
        }));

      let lastReadIndex = 0;
      try {
        const lrRow = this.sql
          .exec(
            "SELECT last_read_index FROM members WHERE user_id = ?",
            userId
          )
          .one() as { last_read_index: number } | undefined;
        lastReadIndex = lrRow?.last_read_index ?? 0;
      } catch {
        /* ignore */
      }

      // For group conversations, include member list and conversation metadata in sync
      const convType = (await this.ctx.storage.get("conversation_type")) as string || "dm";
      const syncPayload: Record<string, unknown> = {
        type: "sync",
        messages: syncMessages,
        lastReadIndex,
      };

      if (convType === "group") {
        const memberCursor = this.sql.exec(
          "SELECT user_id, role, joined_at, last_read_index FROM members ORDER BY joined_at ASC"
        );
        const memberRows = memberCursor.toArray() as Array<{
          user_id: string;
          role: string;
          joined_at: number;
          last_read_index: number;
        }>;
        syncPayload.members = memberRows.map((m) => ({
          userId: m.user_id,
          role: m.role,
          joinedAt: m.joined_at,
          lastReadIndex: m.last_read_index ?? 0,
        }));
        syncPayload.conversationName = (await this.ctx.storage.get("conversation_name")) as string || "";
        syncPayload.conversationType = "group";
      }

      server.send(JSON.stringify(syncPayload));
    } catch (e) {
      console.error("Failed to send sync messages:", e);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Clear any typing indicators that expired while the DO was hibernated
    this.flushExpiredTyping();

    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
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
    const userId = userTag
      ? userTag.slice(USER_TAG_PREFIX.length)
      : "unknown";

    try {
      // Ping doesn't require membership check
      if (msg.type === "ping") {
        this.sendTo(ws, { type: "pong" });
        return;
      }

      // All other operations require active membership
      if (!this.isMember(userId)) {
        this.sendError(ws, "NOT_MEMBER", "You are not a member of this conversation");
        return;
      }

      switch (msg.type) {
        case "text":
          await this.handleTextMessage(ws, userId, msg);
          break;
        case "edit":
          this.handleEditMessage(ws, userId, msg);
          break;
        case "delete":
          this.handleDeleteMessage(ws, userId, msg);
          break;
        case "typing":
          this.handleTypingWithTimeout(ws, userId);
          break;
        case "mark_read":
          this.handleMarkRead(ws, userId, msg.lastReadIndex);
          break;
        case "add_reaction":
          this.handleAddReaction(ws, userId, msg as { type: "add_reaction"; messageId: string; emoji: string });
          break;
        case "remove_reaction":
          this.handleRemoveReaction(ws, userId, msg as { type: "remove_reaction"; messageId: string; emoji: string });
          break;
        default:
          this.sendError(ws, "UNKNOWN_TYPE", "Unknown message type");
      }
    } catch (e) {
      console.error(`Error handling '${msg.type}' from ${userId}:`, e);
      this.sendError(
        ws,
        "INTERNAL_ERROR",
        "Server error processing your message"
      );
    }
  }

  private async handleTextMessage(
    ws: WebSocket,
    userId: string,
    msg: { type: "text"; content: string; tempId?: string; metadata?: Record<string, unknown>; replyToId?: string }
  ): Promise<void> {
    // Validate content
    if (!msg.content || msg.content.trim().length === 0) {
      this.sendError(ws, "EMPTY_MESSAGE", "Message content cannot be empty");
      return;
    }
    if (msg.content.length > MAX_MESSAGE_LENGTH) {
      this.sendError(
        ws,
        "MESSAGE_TOO_LONG",
        `Message exceeds max length of ${MAX_MESSAGE_LENGTH} characters`
      );
      return;
    }

    // Validate metadata size
    if (!this.isValidMetadata(msg.metadata)) {
      this.sendError(ws, "METADATA_TOO_LARGE", `Metadata exceeds max size of ${MAX_METADATA_SIZE} bytes`);
      return;
    }

    // Rate limiting
    if (this.isRateLimited(userId)) {
      this.sendError(ws, "RATE_LIMITED", "Too many messages, slow down");
      return;
    }

    // Clear typing indicator for this user
    this.clearTyping(userId);

    // Dedup: if client retried with same tempId, return the existing message instead of inserting a duplicate
    if (msg.tempId) {
      try {
        const existing = this.sql
          .exec("SELECT id, created_at FROM messages WHERE temp_id = ? AND sender_id = ? LIMIT 1", msg.tempId, userId)
          .toArray() as Array<{ id: string; created_at: number }>;
        if (existing.length > 0) {
          // Already persisted — re-send ack without re-broadcasting
          this.sendTo(ws, {
            type: "message_ack",
            id: existing[0].id,
            tempId: msg.tempId,
            createdAt: existing[0].created_at,
          });
          return;
        }
      } catch { /* table migration may not have run yet — proceed normally */ }
    }

    const id = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const metadataStr = msg.metadata ? JSON.stringify(msg.metadata) : null;

    this.sql.exec(
      "INSERT INTO messages (id, sender_id, content, message_type, created_at, metadata, temp_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      userId,
      msg.content,
      "text",
      now,
      metadataStr,
      msg.tempId || null,
      msg.replyToId || null
    );

    // Send ack to sender
    this.sendTo(ws, {
      type: "message_ack",
      id,
      tempId: msg.tempId,
      createdAt: now,
    });

    // Broadcast to all
    this.broadcast({
      type: "message",
      id,
      senderId: userId,
      content: msg.content,
      messageType: "text",
      createdAt: now,
      tempId: msg.tempId,
      metadata: msg.metadata,
      replyToId: msg.replyToId,
    });

    // Delivery receipts: identify connected users (excluding sender) and notify sender
    const deliveredTo: string[] = [];
    for (const connWs of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(connWs);
      const userTag = tags.find((t) => t.startsWith(USER_TAG_PREFIX));
      const connUserId = userTag ? userTag.slice(USER_TAG_PREFIX.length) : null;
      if (connUserId && connUserId !== userId) {
        deliveredTo.push(connUserId);
      }
    }
    if (deliveredTo.length > 0) {
      this.sendTo(ws, { type: "message_delivered", messageId: id, deliveredTo });
    }

    // Notify all members via push — fire-and-forget.
    // DO has active WebSocket connections so it won't hibernate; promises complete safely.
    // Do NOT await this — awaiting blocks the WebSocket message handler and can cause
    // timeouts when NotificationRouter calls the external FCM API.
    const conversationId = (await this.ctx.storage.get("conversation_id")) as string || "";
    const feature = (await this.ctx.storage.get("conversation_feature")) as string | undefined;
    this.notifyAllMembers(userId, msg.content, conversationId, feature);
  }

  /**
   * Send push notifications only to OFFLINE members (no active WebSocket in this conversation).
   * Uses ctx.waitUntil() to keep the DO alive until all push requests complete,
   * without blocking the WebSocket message handler.
   *
   * For groups: title = "GroupName" or "Group Chat", body = "SenderName: message"
   * For DMs: title = "New message", body = message content (backward compatible)
   */
  private notifyAllMembers(senderId: string, content: string, conversationId: string, feature?: string): void {
    const allMembers = this.sql
      .exec("SELECT user_id, muted FROM members")
      .toArray() as Array<{ user_id: string; muted: number }>;

    // Build set of muted users
    const mutedUserIds = new Set(
      allMembers.filter((m) => m.muted === 1).map((m) => m.user_id)
    );

    const allMemberIds = allMembers.map((m) => m.user_id);

    // Push to ALL members except sender and muted users (regardless of WebSocket connection status)
    const targetMembers = allMemberIds.filter(
      (id) => id !== senderId && !mutedUserIds.has(id)
    );

    console.log(`[PUSH] notifyAllMembers: convId=${conversationId} sender=${senderId} allMembers=[${allMemberIds.join(",")}] targets=[${targetMembers.join(",")}]`);

    if (targetMembers.length === 0) {
      console.log(`[PUSH] No members to notify`);
      return;
    }

    // Build notification title and body based on conversation type
    const pushJob = async () => {
      const convType = (await this.ctx.storage.get("conversation_type")) as string || "dm";
      const convName = (await this.ctx.storage.get("conversation_name")) as string || "";

      // Try to get sender's display name from participants in any member's UserSession
      let senderName = "";
      if (convType === "group" && targetMembers.length > 0) {
        try {
          const stub = this.env.USER_SESSION.get(
            this.env.USER_SESSION.idFromName(`user_${targetMembers[0]}`)
          );
          const res = await stub.fetch(
            `https://internal/conversations?userId=${encodeURIComponent(targetMembers[0])}`
          );
          if (res.ok) {
            const data = (await res.json()) as {
              conversations: Array<{
                conversationId: string;
                participants?: Array<{ userId: string; name?: string }>;
              }>;
            };
            const conv = data.conversations.find((c) => c.conversationId === conversationId);
            const senderP = conv?.participants?.find((p) => p.userId === senderId);
            senderName = senderP?.name || "";
          }
        } catch { /* fallback to no name */ }
      }

      // DM: keep existing notification format for backward compatibility
      // Group: include group name as title, sender name in body
      const truncatedContent = content.length > 100 ? content.slice(0, 100) + "..." : content;
      let pushTitle: string;
      let pushBody: string;

      if (convType === "group") {
        pushTitle = convName || "Group Chat";
        pushBody = senderName ? `${senderName}: ${truncatedContent}` : truncatedContent;
      } else {
        // DM — backward compatible
        pushTitle = senderName || "New message";
        pushBody = truncatedContent;
      }

      const pushPromises = targetMembers.map(async (userId) => {
        try {
          const stub = this.env.NOTIFICATION_ROUTER.get(
            this.env.NOTIFICATION_ROUTER.idFromName(`user_${userId}`)
          );
          const resp = await stub.fetch("https://internal/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: pushTitle,
              body: pushBody,
              data: {
                source: "cloudflare-chat",
                type: "message",
                conversationId,
                senderId,
                ...(senderName ? { senderName } : {}),
                ...(feature ? { feature } : {}),
              },
            }),
          });
          const result = await resp.json() as { ok: boolean; sent?: number; reason?: string };
          console.log(`[PUSH] Push to ${userId}: sent=${result.sent} reason=${result.reason || "ok"}`);
        } catch (e) {
          console.error(`[PUSH] Push to ${userId} failed:`, e);
        }
      });

      await Promise.allSettled(pushPromises);
    };

    // waitUntil keeps the DO alive until all pushes complete, without blocking the handler
    this.ctx.waitUntil(pushJob());
  }

  private handleEditMessage(
    ws: WebSocket,
    userId: string,
    msg: { type: "edit"; messageId: string; newContent: string }
  ): void {
    if (!msg.messageId) {
      this.sendError(ws, "MISSING_FIELD", "messageId is required");
      return;
    }
    if (!msg.newContent || msg.newContent.trim().length === 0) {
      this.sendError(ws, "EMPTY_MESSAGE", "Message content cannot be empty");
      return;
    }
    if (msg.newContent.length > MAX_MESSAGE_LENGTH) {
      this.sendError(
        ws,
        "MESSAGE_TOO_LONG",
        `Message exceeds max length of ${MAX_MESSAGE_LENGTH} characters`
      );
      return;
    }

    const now = Date.now();
    const cursor = this.sql.exec(
      "UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND sender_id = ? AND deleted_at IS NULL",
      msg.newContent,
      now,
      msg.messageId,
      userId
    );

    if (cursor.rowsWritten > 0) {
      this.broadcast({
        type: "message_edited",
        messageId: msg.messageId,
        newContent: msg.newContent,
        editedAt: now,
      });
    } else {
      this.sendError(ws, "EDIT_FAILED", "Message not found or not editable");
    }
  }

  private handleDeleteMessage(
    ws: WebSocket,
    userId: string,
    msg: { type: "delete"; messageId: string }
  ): void {
    if (!msg.messageId) {
      this.sendError(ws, "MISSING_FIELD", "messageId is required");
      return;
    }

    const now = Date.now();
    const cursor = this.sql.exec(
      "UPDATE messages SET deleted_at = ? WHERE id = ? AND sender_id = ?",
      now,
      msg.messageId,
      userId
    );

    if (cursor.rowsWritten > 0) {
      this.broadcast({ type: "message_deleted", messageId: msg.messageId });
    } else {
      this.sendError(
        ws,
        "DELETE_FAILED",
        "Message not found or not deletable"
      );
    }
  }

  // ============ Reactions ============

  private handleAddReaction(
    ws: WebSocket,
    userId: string,
    msg: { type: "add_reaction"; messageId: string; emoji: string }
  ): void {
    if (!msg.messageId || !msg.emoji) {
      this.sendError(ws, "MISSING_FIELD", "messageId and emoji are required");
      return;
    }
    // Verify message exists
    try {
      const row = this.sql.exec("SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL", msg.messageId).one();
      if (!row) {
        this.sendError(ws, "INVALID_VALUE", "Message not found");
        return;
      }
    } catch {
      this.sendError(ws, "INVALID_VALUE", "Message not found");
      return;
    }

    this.sql.exec(
      "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      msg.messageId, userId, msg.emoji, Date.now()
    );

    this.broadcast({ type: "reaction_added", messageId: msg.messageId, userId, emoji: msg.emoji });
  }

  private handleRemoveReaction(
    ws: WebSocket,
    userId: string,
    msg: { type: "remove_reaction"; messageId: string; emoji: string }
  ): void {
    if (!msg.messageId || !msg.emoji) {
      this.sendError(ws, "MISSING_FIELD", "messageId and emoji are required");
      return;
    }

    const cursor = this.sql.exec(
      "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
      msg.messageId, userId, msg.emoji
    );

    if (cursor.rowsWritten > 0) {
      this.broadcast({ type: "reaction_removed", messageId: msg.messageId, userId, emoji: msg.emoji });
    }
  }

  // ============ Typing with timeout ============

  private handleTypingWithTimeout(ws: WebSocket, userId: string): void {
    // Broadcast typing start
    this.broadcastExcept(ws, { type: "typing", userId });

    // Store expiry timestamp (no setTimeout — survives DO hibernation)
    this.typingExpiry.set(userId, Date.now() + TYPING_TIMEOUT_MS);
  }

  /**
   * Check and broadcast typing_stopped for any expired typing indicators.
   * Called at the start of webSocketMessage so stale indicators are cleared
   * even if the DO hibernated and missed a setTimeout callback.
   */
  private flushExpiredTyping(): void {
    const now = Date.now();
    for (const [userId, expiry] of this.typingExpiry) {
      if (now >= expiry) {
        this.typingExpiry.delete(userId);
        this.broadcast({ type: "typing_stopped", userId });
      }
    }
  }

  private clearTyping(userId: string): void {
    if (this.typingExpiry.has(userId)) {
      this.typingExpiry.delete(userId);
      this.broadcast({ type: "typing_stopped", userId });
    }
  }

  private handleMarkRead(
    ws: WebSocket,
    userId: string,
    lastReadIndex: unknown
  ): void {
    if (typeof lastReadIndex !== "number" || !Number.isFinite(lastReadIndex)) {
      this.sendError(ws, "INVALID_VALUE", "lastReadIndex must be a valid number");
      return;
    }

    this.sql.exec(
      "UPDATE members SET last_read_index = ? WHERE user_id = ?",
      lastReadIndex,
      userId
    );

    this.broadcast({
      type: "read_receipt",
      userId,
      lastReadIndex,
      lastReadAt: Date.now(),
    });
  }

  // ============ Broadcast helpers with failure tracking ============

  private broadcast(msg: ServerMessage): void {
    const str = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach((w) => {
      this.safeSend(w, str);
    });
  }

  private broadcastExcept(exclude: WebSocket, msg: ServerMessage): void {
    const str = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach((w) => {
      if (w !== exclude) {
        this.safeSend(w, str);
      }
    });
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    this.safeSend(ws, JSON.stringify(msg));
  }

  /**
   * Safe send with failure tracking. Closes connection after MAX_SEND_FAILURES consecutive failures.
   */
  private safeSend(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
      // Reset failures on success
      this.sendFailures.set(ws, 0);
    } catch (e) {
      const failures = (this.sendFailures.get(ws) || 0) + 1;
      this.sendFailures.set(ws, failures);
      console.error(`Send failed (${failures}/${MAX_SEND_FAILURES}):`, e);

      if (failures >= MAX_SEND_FAILURES) {
        try {
          ws.close(1011, "Too many send failures");
        } catch { /* already closed */ }
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendTo(ws, { type: "error", code, message });
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const userTag = tags.find((t) => t.startsWith(USER_TAG_PREFIX));
    const userId = userTag ? userTag.slice(USER_TAG_PREFIX.length) : null;

    if (userId) {
      // Clear typing indicator
      this.clearTyping(userId);

      // Notify UserSession — decrement connection count
      const conversationId = (await this.ctx.storage.get("conversation_id")) as string || "";
      try {
        const stub = this.env.USER_SESSION.get(
          this.env.USER_SESSION.idFromName(`user_${userId}`)
        );
        await stub.fetch(
          `https://internal/presence?status=offline&source=chat&action=disconnect&conversationId=${encodeURIComponent(conversationId)}`,
          { method: "POST" }
        );
      } catch (e) {
        console.error("Failed to update presence on disconnect:", e);
      }
    }
  }
}
