import { sleep, truncateDiscordContent } from "./util.js";

const API_BASE = "https://discord.com/api/v10";
const INTENTS = 1 + 512 + 4096 + 32768;

export class DiscordBot {
  constructor(config, handlers) {
    this.token = config.discordToken;
    this.handlers = handlers;
    this.sequence = null;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.user = null;
  }

  async start() {
    if (typeof WebSocket === "undefined" || typeof FormData === "undefined" || typeof Blob === "undefined") {
      throw new Error("This bot requires Node.js 22+ with built-in WebSocket, FormData, and Blob support.");
    }

    const gateway = await this.api("/gateway/bot", { method: "GET" });
    if (!gateway.ok) {
      throw new Error(`Unable to fetch Discord gateway: ${gateway.status} ${await gateway.text()}`);
    }

    const body = await gateway.json();
    await this.connect(body.url);
  }

  async connect(gatewayUrl) {
    const url = `${gatewayUrl}/?v=10&encoding=json`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      console.log("Discord gateway connected");
    });

    this.ws.addEventListener("message", (event) => {
      this.handleGatewayMessage(event).catch((error) => {
        console.error("Discord gateway message error:", error);
      });
    });

    this.ws.addEventListener("close", (event) => {
      console.warn(`Discord gateway closed: ${event.code} ${event.reason || ""}`.trim());
      this.cleanupHeartbeat();
      if (!this.stopping) {
        this.scheduleReconnect(gatewayUrl);
      }
    });

    this.ws.addEventListener("error", (event) => {
      console.error("Discord gateway error:", event.error ?? event.message ?? event);
    });
  }

  stop() {
    this.stopping = true;
    this.cleanupHeartbeat();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "shutdown");
    }
  }

  async handleGatewayMessage(event) {
    const payload = JSON.parse(await messageDataToText(event.data));
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;

    switch (payload.op) {
      case 0:
        await this.handleDispatch(payload.t, payload.d);
        break;
      case 7:
        this.ws?.close(4000, "server requested reconnect");
        break;
      case 9:
        await sleep(1500);
        this.identify();
        break;
      case 10:
        this.startHeartbeat(payload.d.heartbeat_interval);
        this.identify();
        break;
      case 11:
        break;
      default:
        break;
    }
  }

  async handleDispatch(type, data) {
    if (type === "READY") {
      this.sessionId = data.session_id;
      this.user = data.user;
      console.log(`Logged in as ${data.user.username}#${data.user.discriminator ?? "0"}`);
      return;
    }

    if (type === "MESSAGE_CREATE") {
      await this.handlers.onMessage?.(data, this);
    }
  }

  startHeartbeat(intervalMs) {
    this.cleanupHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendGateway({ op: 1, d: this.sequence });
    }, intervalMs);
    this.sendGateway({ op: 1, d: this.sequence });
  }

  cleanupHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  identify() {
    this.sendGateway({
      op: 2,
      d: {
        token: this.token,
        intents: INTENTS,
        properties: {
          os: process.platform,
          browser: "coinglass-futures-bot",
          device: "coinglass-futures-bot",
        },
      },
    });
  }

  sendGateway(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  async scheduleReconnect(gatewayUrl) {
    this.reconnectAttempts += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    await sleep(delayMs);
    if (!this.stopping) {
      await this.connect(gatewayUrl);
    }
  }

  async sendTyping(channelId) {
    const response = await this.api(`/channels/${channelId}/typing`, { method: "POST" });
    await drainResponse(response);
    return response.ok;
  }

  async sendText(channelId, content, reference) {
    const response = await this.api(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: truncateDiscordContent(content, 1900),
        message_reference: reference,
        allowed_mentions: { replied_user: false },
      }),
    });
    await throwIfDiscordError(response);
    return response.json();
  }

  async sendMessageWithFiles(channelId, { content, reference, files }) {
    const payload = {
      content: truncateDiscordContent(content, 1900),
      message_reference: reference,
      allowed_mentions: { replied_user: false },
      attachments: files.map((file, index) => ({
        id: String(index),
        filename: file.name,
        description: file.description ?? file.name,
      })),
    };

    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));

    files.forEach((file, index) => {
      const blob = new Blob([file.data], { type: file.contentType || "application/octet-stream" });
      form.append(`files[${index}]`, blob, file.name);
    });

    const response = await this.api(`/channels/${channelId}/messages`, {
      method: "POST",
      body: form,
    });
    await throwIfDiscordError(response);
    return response.json();
  }

  async api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("authorization", `Bot ${this.token}`);

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(body.retry_after ?? 1);
      await sleep(Math.ceil(retryAfter * 1000));
      return this.api(path, options);
    }

    return response;
  }
}

async function messageDataToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

async function throwIfDiscordError(response) {
  if (response.ok) return;
  const text = await response.text();
  throw new Error(`Discord API ${response.status}: ${text}`);
}

async function drainResponse(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // Nothing useful to do here; typing indicators are best-effort.
  }
}
