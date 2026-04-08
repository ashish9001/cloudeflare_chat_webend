/**
 * NotificationRouter Durable Object - Phase 4: Push notifications
 * One instance per user, stores FCM/APNs tokens and sends push notifications
 *
 * FCM: Uses HTTP v1 API with service account OAuth2 (legacy API shut down July 2024)
 * APNs: Uses token-based auth (ES256 JWT)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env, PushNotificationPayload } from "./types";

interface DeviceRegistration {
  platform: "android" | "ios";
  token: string;
  /** VoIP push token for iOS (PushKit) — used for call_incoming pushes */
  voipToken?: string;
  /** App build / tenant id (e.g. hex from CMS). */
  appId?: string;
  /** Must match JWT user when sent; stored for debugging / list devices. */
  userId?: string;
  /** APNs bundle id (topic) for iOS, e.g. com.push.temp — used as apns-topic when sending. */
  signature?: string;
  registeredAt: number;
}

const MAX_DEVICES_PER_USER = 5;

// Cached OAuth2 access token (shared across requests within the same DO instance)
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export class NotificationRouter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      return this.handleRegister(request);
    }

    if (url.pathname === "/unregister" && request.method === "POST") {
      return this.handleUnregister(request);
    }

    if (url.pathname === "/send" && request.method === "POST") {
      return this.handleSendPush(request);
    }

    if (url.pathname === "/devices" && request.method === "GET") {
      return this.handleListDevices();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleRegister(request: Request): Promise<Response> {
    let body: {
      platform: "android" | "ios";
      token: string;
      voipToken?: string;
      appId?: string;
      userId?: string;
      signature?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.platform || !body.token) {
      return new Response(
        JSON.stringify({ error: "platform and token required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (body.platform !== "android" && body.platform !== "ios") {
      return new Response(
        JSON.stringify({ error: "platform must be 'android' or 'ios'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (typeof body.token !== "string" || body.token.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "token must be a non-empty string" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const devices = ((await this.ctx.storage.get("devices")) as DeviceRegistration[]) ?? [];
    const existing = devices.findIndex((d) => d.token === body.token);
    const reg: DeviceRegistration = {
      platform: body.platform,
      token: body.token,
      voipToken: body.voipToken,
      appId: body.appId,
      userId: body.userId,
      signature: body.signature,
      registeredAt: Date.now(),
    };

    if (existing >= 0) {
      devices[existing] = reg;
    } else {
      devices.push(reg);
    }

    // Keep at most N devices per user
    const trimmed = devices
      .sort((a, b) => b.registeredAt - a.registeredAt)
      .slice(0, MAX_DEVICES_PER_USER);

    await this.ctx.storage.put("devices", trimmed);

    console.log(`[DEVICES] handleRegister: platform=${body.platform} tokenSuffix=...${body.token.slice(-8)} appId=${body.appId || 'none'} userId=${body.userId || 'none'} signature=${body.signature || 'none'} totalDevices=${trimmed.length} existing=${existing >= 0 ? 'updated' : 'new'}`);

    return new Response(
      JSON.stringify({ ok: true, deviceCount: trimmed.length }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleUnregister(request: Request): Promise<Response> {
    let body: { token: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!body.token || typeof body.token !== "string") {
      return new Response(
        JSON.stringify({ error: "token is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const devices = ((await this.ctx.storage.get("devices")) as DeviceRegistration[]) ?? [];
    const filtered = devices.filter((d) => d.token !== body.token);
    await this.ctx.storage.put("devices", filtered);

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleListDevices(): Promise<Response> {
    const devices = ((await this.ctx.storage.get("devices")) as DeviceRegistration[]) ?? [];
    return new Response(
      JSON.stringify({
        devices: devices.map((d) => ({
          platform: d.platform,
          registeredAt: d.registeredAt,
          appId: d.appId,
          userId: d.userId,
          signature: d.signature,
          // Don't expose full token — show last 6 chars only
          tokenSuffix: d.token.slice(-6),
        })),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Send push notification to all registered devices for this user.
   */
  private async handleSendPush(request: Request): Promise<Response> {
    let payload: PushNotificationPayload;
    try {
      payload = (await request.json()) as PushNotificationPayload;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!payload.title || !payload.body) {
      return new Response(
        JSON.stringify({ error: "title and body required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const devices = ((await this.ctx.storage.get("devices")) as DeviceRegistration[]) ?? [];
    console.log(`[PUSH] handleSendPush: title="${payload.title}" body="${payload.body}" data=${JSON.stringify(payload.data)} deviceCount=${devices.length}`);

    if (devices.length === 0) {
      console.log(`[PUSH] No devices registered for this user — push skipped`);
      return new Response(
        JSON.stringify({ ok: true, sent: 0, reason: "no_devices" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const results: Array<{ platform: string; success: boolean; error?: string }> = [];
    const invalidTokens: string[] = [];

    for (const device of devices) {
      console.log(`[PUSH] Sending to ${device.platform} device (token: ...${device.token.slice(-8)})`);
      try {
        if (device.platform === "android") {
          const result = await this.sendFCMv1(device.token, payload);
          results.push({ platform: "android", success: result.success });
          if (result.invalidToken) invalidTokens.push(device.token);
        } else if (device.platform === "ios") {
          // For call_incoming, use VoIP push if voipToken is available
          const isCallPush = payload.data?.type === "call_incoming";
          if (isCallPush && device.voipToken) {
            const result = await this.sendAPNs(device.voipToken, payload, device.signature, device.appId, "voip");
            results.push({ platform: "ios-voip", success: result.success });
            if (result.invalidToken) invalidTokens.push(device.voipToken);
          } else {
            const result = await this.sendAPNs(device.token, payload, device.signature, device.appId);
            results.push({ platform: "ios", success: result.success });
            if (result.invalidToken) invalidTokens.push(device.token);
          }
        }
      } catch (e) {
        console.error(`Push send failed for ${device.platform}:`, e);
        results.push({
          platform: device.platform,
          success: false,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    // Remove invalid tokens
    if (invalidTokens.length > 0) {
      const validDevices = devices.filter((d) => !invalidTokens.includes(d.token));
      await this.ctx.storage.put("devices", validDevices);
    }

    const sent = results.filter((r) => r.success).length;
    return new Response(
      JSON.stringify({ ok: true, sent, total: devices.length }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ============ FCM HTTP v1 API ============

  /**
   * Send push via FCM HTTP v1 API (replaces deprecated legacy API).
   * Uses service account OAuth2 for authentication.
   * Requires: FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
   */
  private async sendFCMv1(
    token: string,
    payload: PushNotificationPayload
  ): Promise<{ success: boolean; invalidToken?: boolean }> {
    if (!this.env.FCM_PROJECT_ID || !this.env.FCM_CLIENT_EMAIL || !this.env.FCM_PRIVATE_KEY) {
      console.error("[PUSH] FCM v1 credentials MISSING — check wrangler secrets:", {
        hasProjectId: !!this.env.FCM_PROJECT_ID,
        hasClientEmail: !!this.env.FCM_CLIENT_EMAIL,
        hasPrivateKey: !!this.env.FCM_PRIVATE_KEY,
      });
      return { success: false };
    }

    console.log(`[PUSH] sendFCMv1: getting OAuth2 access token...`);

    // Get or refresh OAuth2 access token
    const accessToken = await this.getFCMAccessToken();
    if (!accessToken) {
      console.error("[PUSH] Failed to obtain FCM OAuth2 access token — check FCM_PRIVATE_KEY format (must be valid PEM)");
      return { success: false };
    }

    console.log(`[PUSH] sendFCMv1: got access token, sending to FCM v1 API (project=${this.env.FCM_PROJECT_ID})`);

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${this.env.FCM_PROJECT_ID}/messages:send`;

    // Data-only message (no "notification" block) so onMessageReceived always fires
    // in both foreground and background — matching Twilio's approach.
    // All fields must be strings in FCM data payload.
    const dataPayload: Record<string, string> = {
      ...(payload.data || {}),
      title: payload.title || "New message",
      body: payload.body || "",
    };

    const fcmBody = JSON.stringify({
      message: {
        token: token,
        data: dataPayload,
        android: {
          priority: "HIGH",
        },
      },
    });

    const doFcmRequest = async (authToken: string): Promise<globalThis.Response> => {
      return fetch(fcmUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: fcmBody,
      });
    };

    let response = await doFcmRequest(accessToken);

    // Retry once on 401 (expired token) with a fresh OAuth2 token
    if (response.status === 401) {
      console.warn("[PUSH] FCM 401 — access token expired, refreshing and retrying...");
      cachedAccessToken = null;
      const freshToken = await this.getFCMAccessToken();
      if (freshToken) {
        response = await doFcmRequest(freshToken);
      } else {
        console.error("[PUSH] FCM retry failed — could not obtain fresh access token");
        return { success: false };
      }
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[PUSH] FCM v1 FAILED (${response.status}): ${text}`);

      // Parse error for invalid token detection
      try {
        const errJson = JSON.parse(text);
        const errCode = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status;
        if (errCode === "UNREGISTERED" || response.status === 404) {
          console.warn(`[PUSH] FCM token invalid (${errCode}) — marking for removal`);
          return { success: false, invalidToken: true };
        }
      } catch {
        // Ignore parse errors
      }

      return { success: false };
    }

    console.log(`[PUSH] FCM v1 SUCCESS — notification delivered to device`);
    return { success: true };
  }

  /**
   * Get a valid OAuth2 access token for FCM v1 API.
   * Creates a JWT signed with the service account private key,
   * then exchanges it for an access token via Google's OAuth endpoint.
   * Tokens are cached for ~55 minutes (5 min buffer before 1hr expiry).
   */
  private async getFCMAccessToken(): Promise<string | null> {
    // Return cached token if still valid
    if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
      return cachedAccessToken.token;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + 3600; // 1 hour

      // Build JWT header + claims
      const header = { alg: "RS256", typ: "JWT" };
      const claims = {
        iss: this.env.FCM_CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: expiry,
      };

      const headerB64 = this.base64UrlEncode(JSON.stringify(header));
      const claimsB64 = this.base64UrlEncode(JSON.stringify(claims));
      const signingInput = `${headerB64}.${claimsB64}`;

      // Import RSA private key
      const keyData = this.pemToArrayBuffer(this.env.FCM_PRIVATE_KEY || "");
      if (keyData.byteLength === 0) {
        console.error("[PUSH] getFCMAccessToken: RSA private key is empty — check FCM_PRIVATE_KEY secret");
        return null;
      }
      const key = await crypto.subtle.importKey(
        "pkcs8",
        keyData,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      );

      // Sign the JWT
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput)
      );

      const signatureB64 = this.base64UrlEncodeBuffer(new Uint8Array(signature));
      const jwt = `${signingInput}.${signatureB64}`;

      // Exchange JWT for access token
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        console.error(`[PUSH] OAuth2 token exchange FAILED (${tokenResponse.status}): ${errText}`);
        return null;
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        expires_in: number;
      };

      // Cache with 5-minute buffer
      cachedAccessToken = {
        token: tokenData.access_token,
        expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000,
      };

      return tokenData.access_token;
    } catch (e) {
      console.error("Failed to get FCM access token:", e);
      return null;
    }
  }

  // ============ APNs ============

  /**
   * Send push via Apple Push Notification Service (APNs)
   * Uses token-based authentication (JWT)
   */
  private async sendAPNs(
    deviceToken: string,
    payload: PushNotificationPayload,
    /** Bundle id / apns-topic — from registration field `signature` (preferred for iOS). */
    signature?: string,
    /** Optional app id from registration (hex or legacy); not used as topic unless it looks like a bundle id. */
    deviceAppId?: string,
    /** Push type: "alert" (default) or "voip" for call notifications */
    pushType: "alert" | "voip" = "alert"
  ): Promise<{ success: boolean; invalidToken?: boolean }> {
    if (!this.env.APNS_KEY_ID || !this.env.APNS_TEAM_ID || !this.env.APNS_PRIVATE_KEY) {
      console.warn("APNs credentials not set, skipping iOS push");
      return { success: false };
    }

    // APNs topic: prefer `signature` (bundle id, e.g. com.push.temp), then bundle-like appId, then env.
    // Do not use hex app ids (no ".") as topic.
    let apnsTopic: string | undefined;
    if (signature?.includes(".")) apnsTopic = signature.trim();
    else if (deviceAppId?.includes(".")) apnsTopic = deviceAppId.trim();
    else if (signature?.trim()) apnsTopic = signature.trim();
    else apnsTopic = this.env.APNS_BUNDLE_ID;
    if (!apnsTopic) {
      console.warn("APNs: no apns-topic (signature, bundle-like appId, or APNS_BUNDLE_ID), skipping");
      return { success: false };
    }

    // For VoIP pushes, append .voip to the topic
    const effectiveTopic = pushType === "voip" ? `${apnsTopic}.voip` : apnsTopic;

    const apnsJwt = await this.generateAPNsJWT();

    // Sandbox only for known debug bundle (tokens must match endpoint).
    const isDebugBuild = apnsTopic === "com.pushtest.temp";
    const apnsHost = isDebugBuild
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";
    const apnsUrl = `https://${apnsHost}/3/device/${deviceToken}`;

    // VoIP pushes have a different payload structure — no alert, just data
    const apnsPayload = pushType === "voip"
      ? {
          aps: {},
          ...(payload.data || {}),
          // Include title/body as data fields for the app to use
          pushTitle: payload.title,
          pushBody: payload.body,
        }
      : {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: "default",
            badge: 1,
            "mutable-content": 1,
          },
          ...(payload.data || {}),
        };

    console.log(`[PUSH] sendAPNs: host=${apnsHost} topic=${effectiveTopic} pushType=${pushType} token=...${deviceToken.slice(-8)}`);

    const response = await fetch(apnsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${apnsJwt}`,
        "apns-topic": effectiveTopic,
        "apns-push-type": pushType,
        "apns-priority": "10",
        "apns-expiration": "0",
      },
      body: JSON.stringify(apnsPayload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`APNs error (${response.status}): ${text}`);

      // Token is invalid
      if (response.status === 400 || response.status === 410) {
        return { success: false, invalidToken: true };
      }
      return { success: false };
    }

    return { success: true };
  }

  /**
   * Generate APNs JWT for token-based auth
   */
  private async generateAPNsJWT(): Promise<string> {
    const header = {
      alg: "ES256",
      kid: this.env.APNS_KEY_ID,
    };

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.env.APNS_TEAM_ID,
      iat: now,
    };

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const claimsB64 = this.base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${headerB64}.${claimsB64}`;

    // Import the P-256 private key
    const keyData = this.pemToArrayBuffer(this.env.APNS_PRIVATE_KEY || "");
    if (keyData.byteLength === 0) {
      console.error("[PUSH] generateAPNsJWT: EC private key is empty — check APNS_PRIVATE_KEY secret");
      throw new Error("APNs private key is empty");
    }
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput)
    );

    const signatureB64 = this.base64UrlEncodeBuffer(new Uint8Array(signature));

    return `${signingInput}.${signatureB64}`;
  }

  // ============ Utility ============

  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private base64UrlEncodeBuffer(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private pemToArrayBuffer(pem: string): ArrayBuffer {
    // Keys pasted from Firebase/Apple JSON files contain literal "\n" (two chars)
    // instead of real newlines. Convert them before stripping.
    const b64 = pem
      .replace(/\\n/g, "\n")
      .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
      .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");

    if (b64.length === 0) {
      console.error("[PUSH] pemToArrayBuffer: PEM key is empty after stripping headers — check secret format");
    }

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}