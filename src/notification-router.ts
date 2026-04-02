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
  appId?: string;
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
      appId?: string;
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
      appId: body.appId,
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
          const result = await this.sendAPNs(device.token, payload);
          results.push({ platform: "ios", success: result.success });
          if (result.invalidToken) invalidTokens.push(device.token);
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
      console.warn("[PUSH] FCM v1 credentials not set (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY), skipping Android push");
      return { success: false };
    }

    console.log(`[PUSH] sendFCMv1: getting OAuth2 access token...`);

    // Get or refresh OAuth2 access token
    const accessToken = await this.getFCMAccessToken();
    if (!accessToken) {
      console.error("[PUSH] Failed to obtain FCM OAuth2 access token");
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

    const response = await fetch(fcmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: token,
          data: dataPayload,
          android: {
            priority: "HIGH",
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[PUSH] FCM v1 FAILED (${response.status}): ${text}`);

      // Parse error for invalid token detection
      try {
        const errJson = JSON.parse(text);
        const errCode = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status;
        if (errCode === "UNREGISTERED" || errCode === "INVALID_ARGUMENT" || response.status === 404) {
          return { success: false, invalidToken: true };
        }
      } catch {
        // Ignore parse errors
      }

      if (response.status === 401) {
        // Token expired — clear cache and retry once
        cachedAccessToken = null;
        console.warn("FCM access token expired, cleared cache");
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
    payload: PushNotificationPayload
  ): Promise<{ success: boolean; invalidToken?: boolean }> {
    if (!this.env.APNS_KEY_ID || !this.env.APNS_TEAM_ID || !this.env.APNS_BUNDLE_ID || !this.env.APNS_PRIVATE_KEY) {
      console.warn("APNs credentials not set, skipping iOS push");
      return { success: false };
    }

    const apnsJwt = await this.generateAPNsJWT();
    const apnsUrl = `https://api.push.apple.com/3/device/${deviceToken}`;

    const apnsPayload = {
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

    const response = await fetch(apnsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${apnsJwt}`,
        "apns-topic": this.env.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
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
    const b64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
      .replace(/-----END RSA PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}