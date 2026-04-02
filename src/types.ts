/**
 * Shared types for Cloudflare Chat Server
 * Used across Worker, Durable Objects, and SDK protocol
 */

export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  USER_SESSION: DurableObjectNamespace;
  NOTIFICATION_ROUTER: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
  MEDIA_BUCKET?: R2Bucket;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  AUTH_SECRET?: string;
  // FCM HTTP v1 API (service account credentials from Firebase Console)
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRIVATE_KEY?: string;
  TURN_SECRET?: string;
  TURN_SERVER_URL?: string;
  ALLOWED_ORIGINS?: string; // comma-separated origins for CORS
}

// ============ WebSocket Message Types ============

export type ClientMessageType =
  | "text"
  | "edit"
  | "delete"
  | "typing"
  | "mark_read"
  | "join"
  | "ping"
  | "add_reaction"
  | "remove_reaction";

export type ServerMessageType =
  | "message"
  | "message_ack"
  | "message_edited"
  | "message_deleted"
  | "read_receipt"
  | "typing"
  | "typing_stopped"
  | "presence_update"
  | "member_added"
  | "member_removed"
  | "role_changed"
  | "conversation_updated"
  | "reaction_added"
  | "reaction_removed"
  | "message_delivered"
  | "error"
  | "pong"
  | "sync"
  | "call_incoming"
  | "call_accepted"
  | "call_rejected"
  | "call_ended";

// Client -> Server messages
export interface TextMessage {
  type: "text";
  content: string;
  tempId?: string;
  metadata?: Record<string, unknown>;
  replyToId?: string;
}

export interface EditMessage {
  type: "edit";
  messageId: string;
  newContent: string;
}

export interface DeleteMessage {
  type: "delete";
  messageId: string;
}

export interface TypingMessage {
  type: "typing";
}

export interface MarkReadMessage {
  type: "mark_read";
  lastReadIndex: number;
}

export interface JoinMessage {
  type: "join";
  userId: string;
  conversationId: string;
  token?: string;
}

export interface PingMessage {
  type: "ping";
}

export interface AddReactionMessage {
  type: "add_reaction";
  messageId: string;
  emoji: string; // e.g. "👍", "❤️", "😂"
}

export interface RemoveReactionMessage {
  type: "remove_reaction";
  messageId: string;
  emoji: string;
}

export type ClientMessage =
  | TextMessage
  | EditMessage
  | DeleteMessage
  | TypingMessage
  | MarkReadMessage
  | JoinMessage
  | PingMessage
  | AddReactionMessage
  | RemoveReactionMessage;

// Server -> Client messages
export interface MessageReaction {
  userId: string;
  emoji: string;
}

export interface MessagePayload {
  type: "message";
  id: string;
  senderId: string;
  content: string;
  messageType: string;
  createdAt: number;
  editedAt?: number;
  tempId?: string;
  metadata?: Record<string, unknown>;
  replyToId?: string;
  reactions?: MessageReaction[];
}

export interface MessageAckPayload {
  type: "message_ack";
  id: string;
  tempId?: string;
  createdAt: number;
}

export interface MessageEditedPayload {
  type: "message_edited";
  messageId: string;
  newContent: string;
  editedAt: number;
}

export interface MessageDeletedPayload {
  type: "message_deleted";
  messageId: string;
}

export interface ReadReceiptPayload {
  type: "read_receipt";
  userId: string;
  lastReadIndex: number;
  lastReadAt: number;
}

export interface TypingPayload {
  type: "typing";
  userId: string;
}

export interface TypingStoppedPayload {
  type: "typing_stopped";
  userId: string;
}

export interface PresencePayload {
  type: "presence_update";
  userId: string;
  status: "online" | "offline" | "away";
  lastSeen?: number;
}

export interface MemberAddedPayload {
  type: "member_added";
  userId: string;
  addedBy: string;
}

export interface MemberRemovedPayload {
  type: "member_removed";
  userId: string;
  removedBy: string;
}

export interface RoleChangedPayload {
  type: "role_changed";
  userId: string;
  newRole: "admin" | "member";
  changedBy: string;
}

export interface ConversationUpdatedPayload {
  type: "conversation_updated";
  name?: string;
  updatedBy: string;
}

export interface ReactionAddedPayload {
  type: "reaction_added";
  messageId: string;
  userId: string;
  emoji: string;
}

export interface ReactionRemovedPayload {
  type: "reaction_removed";
  messageId: string;
  userId: string;
  emoji: string;
}

export interface MessageDeliveredPayload {
  type: "message_delivered";
  messageId: string;
  deliveredTo: string[];
}

export interface ErrorPayload {
  type: "error";
  code: string;
  message: string;
}

export interface SyncPayload {
  type: "sync";
  messages: MessagePayload[];
  lastReadIndex: number;
}

export interface PongPayload {
  type: "pong";
}

// Call signaling payloads
export interface CallIncomingPayload {
  type: "call_incoming";
  callId: string;
  callerId: string;
  callType: "voice" | "video";
}

export interface CallAcceptedPayload {
  type: "call_accepted";
  callId: string;
  userId: string;
}

export interface CallRejectedPayload {
  type: "call_rejected";
  callId: string;
  userId: string;
  reason?: string;
}

export interface CallEndedPayload {
  type: "call_ended";
  callId: string;
  endedBy: string;
  reason: "hangup" | "timeout" | "declined" | "error";
}

export type ServerMessage =
  | MessagePayload
  | MessageAckPayload
  | MessageEditedPayload
  | MessageDeletedPayload
  | ReadReceiptPayload
  | TypingPayload
  | TypingStoppedPayload
  | PresencePayload
  | MemberAddedPayload
  | MemberRemovedPayload
  | RoleChangedPayload
  | ConversationUpdatedPayload
  | ReactionAddedPayload
  | ReactionRemovedPayload
  | MessageDeliveredPayload
  | ErrorPayload
  | SyncPayload
  | PongPayload
  | CallIncomingPayload
  | CallAcceptedPayload
  | CallRejectedPayload
  | CallEndedPayload;

// ============ REST API Types ============

export interface Conversation {
  id: string;
  type: "dm" | "group";
  name?: string;
  feature?: string;
  memberIds: string[];
  lastMessage?: MessagePayload;
  unreadCount: number;
  lastUnreadMessage?: MessagePayload | null;
  createdAt: number;
}

export interface AuthPayload {
  userId: string;
  appId?: string;
}

export interface ConversationParticipant {
  userId: string;
  name?: string;
  email?: string;
  image?: string;
}

// ============ Push Notification Types ============

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ============ Call Types ============

export type CallState = "ringing" | "active" | "ended";

export interface CallInfo {
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
