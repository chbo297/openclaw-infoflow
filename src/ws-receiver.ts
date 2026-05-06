/**
 * WebSocket inbound receiver: wraps SDK WSClient for long-lived message delivery.
 * Normalizes events into the same msgData shape as the webhook path, then calls
 * handleGroupChatMessage / handlePrivateChatMessage.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  checkBotMentioned,
  handleGroupChatMessage,
  handlePrivateChatMessage,
} from "./bot.js";
import { formatInfoflowError, getInfoflowWebhookLog, logVerbose } from "./logging.js";
import { isDuplicateMessage } from "./infoflow-req-parse.js";
import { extractIdFromRawJson } from "./send.js";
import type { ResolvedInfoflowAccount } from "./types.js";

export type WSReceiverOptions = {
  account: ResolvedInfoflowAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type GroupInboundSeenKind = "forward" | "mention";

const GROUP_INBOUND_TTL_MS = 5 * 60 * 1000;
const GROUP_INBOUND_MAX_SIZE = 2048;
const groupInboundSeen = new Map<string, { kind: GroupInboundSeenKind; seenAt: number }>();

function pruneGroupInboundSeen(now: number): void {
  for (const [key, value] of groupInboundSeen) {
    if (now - value.seenAt > GROUP_INBOUND_TTL_MS) {
      groupInboundSeen.delete(key);
    }
  }
  if (groupInboundSeen.size <= GROUP_INBOUND_MAX_SIZE) return;
  const overflow = groupInboundSeen.size - GROUP_INBOUND_MAX_SIZE;
  const oldest = [...groupInboundSeen.entries()]
    .sort((a, b) => a[1].seenAt - b[1].seenAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    groupInboundSeen.delete(key);
  }
}

function shouldSkipDuplicateGroupEvent(
  dedupKey: string,
  incomingKind: GroupInboundSeenKind,
): boolean {
  const now = Date.now();
  pruneGroupInboundSeen(now);
  const existing = groupInboundSeen.get(dedupKey);
  if (!existing) {
    groupInboundSeen.set(dedupKey, { kind: incomingKind, seenAt: now });
    return false;
  }
  if (incomingKind === "forward") {
    existing.seenAt = now;
    return true;
  }
  if (existing.kind === "mention") {
    existing.seenAt = now;
    return true;
  }
  groupInboundSeen.set(dedupKey, { kind: "mention", seenAt: now });
  return false;
}

function botMentionIdentity(account: ResolvedInfoflowAccount) {
  return {
    robotName: account.config.robotName,
    appAgentId: account.config.appAgentId,
    robotId: account.config.robotId?.trim() || undefined,
  };
}

type WsClientInstance = {
  on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => void;
  off?: (event: string, handler: unknown) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  eventDispatcher?: { normalizePrivateMessage?: (p: unknown) => unknown };
  frameCodec?: { parsePayload?: (frame: unknown) => unknown };
  handleDisconnect?: (...args: unknown[]) => void;
  stopHeartbeat?: () => void;
  state?: string;
  serverConfig?: Record<string, unknown>;
  maxReconnectAttempts?: number;
  reconnectAttempts?: number;
};

export class InfoflowWSReceiver {
  private wsClient: WsClientInstance | null = null;
  private options: WSReceiverOptions;
  private stopped = false;
  private handleGroupEventRef: ((...args: unknown[]) => void | Promise<void>) | null = null;
  private handlePrivateEventRef: ((...args: unknown[]) => void | Promise<void>) | null = null;

  constructor(options: WSReceiverOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    let WSClient: new (opts: Record<string, unknown>) => WsClientInstance;
    try {
      ({ WSClient } = await import("@baidu/infoflow-sdk-nodejs"));
    } catch (err) {
      throw new Error(
        `Infoflow WebSocket mode requires @baidu/infoflow-sdk-nodejs (install from the Baidu npm registry). ${formatInfoflowError(err)}`,
      );
    }

    const { appKey, appSecret } = this.options.account.config;
    const wsGateway = this.options.account.config.wsGateway;
    const wsConnectDomain = this.options.account.config.wsConnectDomain;

    this.wsClient = new WSClient({
      appId: appKey,
      appSecret: appSecret,
      wsGateway,
      ...(wsConnectDomain ? { wsConnectDomain } : {}),
      endpointTimeout: 15_000,
    });

    const client = this.wsClient;
    const dispatcher = client.eventDispatcher;
    if (dispatcher && typeof dispatcher.normalizePrivateMessage === "function") {
      const original = dispatcher.normalizePrivateMessage.bind(dispatcher);
      dispatcher.normalizePrivateMessage = (payload: unknown) => {
        const normalized = original(payload) as Record<string, unknown>;
        normalized.originalMessage = payload;
        return normalized;
      };
    }

    const frameCodec = client.frameCodec;
    if (frameCodec && typeof frameCodec.parsePayload === "function") {
      const originalParse = frameCodec.parsePayload.bind(frameCodec);
      frameCodec.parsePayload = (frame: unknown) => {
        const f = frame as { method?: string; payload?: Buffer };
        const result = originalParse(frame) as Record<string, unknown> | null;
        if (result && typeof result === "object" && f.payload) {
          try {
            result._rawJson = f.payload.toString("utf-8");
          } catch {
            /* ignore */
          }
        }
        const method = f.method ?? "?";
        getInfoflowWebhookLog().info(
          `[ws:frame] method=${method}, payloadLen=${f.payload?.length ?? 0}`,
        );
        return result;
      };
    }

    const rawHandleDisconnect = client.handleDisconnect;
    if (typeof rawHandleDisconnect === "function") {
      const originalHandleDisconnect = rawHandleDisconnect.bind(client);
      client.handleDisconnect = (...args: unknown[]) => {
        if (this.stopped) {
          try {
            client.stopHeartbeat?.();
          } catch {
            /* ignore */
          }
          client.state = "disconnected";
          return;
        }
        return originalHandleDisconnect(...args);
      };
    }

    getInfoflowWebhookLog().info(
      `[ws:init] WSClient created: appKey=${appKey.slice(0, 4)}***, gateway=${wsGateway}, endpointTimeout=15000ms`,
    );

    const handleGroupEvent = async (...args: unknown[]) => {
      const event = args[0] as { data?: unknown; type?: string };
      getInfoflowWebhookLog().info(
        `[ws:inbound] group event received, type=${event?.type ?? (event?.data as { msgType?: string })?.msgType ?? "?"}`,
      );
      if (this.stopped) {
        getInfoflowWebhookLog().warn(`[ws:inbound] group event dropped (receiver stopped)`);
        return;
      }
      try {
        const data = (event?.data ?? event) as Record<string, unknown>;
        await this.handleGroupEvent(data);
      } catch (err) {
        getInfoflowWebhookLog().error(`[ws:inbound] group handler error: ${formatInfoflowError(err)}`);
      }
    };
    this.wsClient.on("group.*", handleGroupEvent);
    this.handleGroupEventRef = handleGroupEvent;

    const handlePrivateEvent = async (...args: unknown[]) => {
      const event = args[0] as { data?: unknown; type?: string };
      getInfoflowWebhookLog().info(
        `[ws:inbound] private event received, type=${event?.type ?? (event?.data as { msgType?: string })?.msgType ?? "?"}`,
      );
      if (this.stopped) {
        getInfoflowWebhookLog().warn(`[ws:inbound] private event dropped (receiver stopped)`);
        return;
      }
      try {
        const data = (event?.data ?? event) as Record<string, unknown>;
        await this.handlePrivateEvent(data);
      } catch (err) {
        getInfoflowWebhookLog().error(`[ws:inbound] private handler error: ${formatInfoflowError(err)}`);
      }
    };
    this.wsClient.on("private.*", handlePrivateEvent);
    this.handlePrivateEventRef = handlePrivateEvent;

    this.wsClient.on("connected" as never, (...args: unknown[]) => {
      const event = args[0] as { connectionId?: string };
      getInfoflowWebhookLog().info(
        `[ws:connect] websocket connected, connection_id=${event?.connectionId ?? "?"}`,
      );
    });
    this.wsClient.on("disconnected" as never, (...args: unknown[]) => {
      const event = args[0] as { connectionId?: string };
      getInfoflowWebhookLog().warn(
        `[ws:disconnect] websocket disconnected, connection_id=${event?.connectionId ?? "?"}`,
      );
    });
    this.wsClient.on("error" as never, (...args: unknown[]) => {
      const event = args[0] as { error?: { message?: string } };
      const msg = event?.error?.message ?? String(event?.error ?? event ?? "unknown");
      getInfoflowWebhookLog().error(`[ws:error] websocket error: ${msg}`);
    });

    getInfoflowWebhookLog().info(`[ws:connect] connecting to ${wsGateway}`);
    await this.wsClient.connect();
    getInfoflowWebhookLog().info(`[ws:connect] initial connection established`);

    this.options.abortSignal.addEventListener(
      "abort",
      () => {
        this.stop();
      },
      { once: true },
    );
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const client = this.wsClient;
    if (this.handleGroupEventRef && client?.off) {
      try {
        client.off("group.*", this.handleGroupEventRef);
      } catch {
        /* ignore */
      }
      this.handleGroupEventRef = null;
    }
    if (this.handlePrivateEventRef && client?.off) {
      try {
        client.off("private.*", this.handlePrivateEventRef);
      } catch {
        /* ignore */
      }
      this.handlePrivateEventRef = null;
    }
    if (!client) return;

    getInfoflowWebhookLog().info(`[ws:disconnect] stopping ws receiver`);
    try {
      client.stopHeartbeat?.();
      if (client.serverConfig && typeof client.serverConfig === "object") {
        client.serverConfig = {
          ...client.serverConfig,
          reconnect_count: 0,
        };
      }
      client.maxReconnectAttempts = 0;
      client.reconnectAttempts = 0;
    } catch {
      /* ignore */
    }
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
  }

  private async handleGroupEvent(data: Record<string, unknown>): Promise<void> {
    if (!data) return;

    this.options.statusSink?.({ lastInboundAt: Date.now() });

    const payload = (data.raw ?? data) as Record<string, unknown>;
    const originalMessage = (payload.originalMessage ?? payload) as Record<string, unknown>;
    const message = (payload.message ?? originalMessage.message ?? {}) as Record<string, unknown>;
    const header = (message.header ?? originalMessage.header ?? {}) as Record<string, unknown>;

    const rawJson = payload._rawJson as string | undefined;
    const preciseMessageId =
      (rawJson && extractIdFromRawJson(rawJson, "messageid")) ??
      (header.messageid != null ? String(header.messageid) : undefined);
    const preciseClientMsgId =
      (rawJson && extractIdFromRawJson(rawJson, "clientmsgid")) ??
      (header.clientmsgid != null ? String(header.clientmsgid) : undefined);

    const preciseMsgId2 =
      (rawJson && extractIdFromRawJson(rawJson, "msgid2")) ??
      (payload.msgid2 != null
        ? String(payload.msgid2)
        : originalMessage.msgid2 != null
          ? String(originalMessage.msgid2)
          : undefined);

    const rawEventType: string = String(
      payload.eventtype ??
        payload.eventType ??
        originalMessage.eventtype ??
        originalMessage.eventType ??
        "MESSAGE_RECEIVE",
    );
    const bodyItems = (message.body ?? payload.body ?? data.body ?? []) as Array<{
      type?: string;
      name?: string;
      robotid?: number;
    }>;
    const isMentionEvent =
      rawEventType === "MESSAGE_RECEIVE"
        ? true
        : checkBotMentioned(bodyItems, botMentionIdentity(this.options.account));

    getInfoflowWebhookLog().info(
      `[ws:inbound] group eventtype=${rawEventType}, wasMentioned=${isMentionEvent}`,
    );

    const msgData: Record<string, unknown> = {
      eventtype: rawEventType,
      groupid: payload.groupid ?? payload.groupId ?? data.groupId,
      fromid: payload.fromid,
      msgid2: preciseMsgId2,
      wasMentioned: isMentionEvent,
      message: {
        header: {
          fromuserid: header.fromuserid ?? payload.fromUserId ?? data.fromUserId ?? "",
          toid: payload.groupid ?? payload.groupId ?? data.groupId,
          totype: "GROUP",
          msgtype: header.msgtype ?? data.msgType ?? "text",
          messageid: preciseMessageId,
          clientmsgid: preciseClientMsgId,
          servertime: header.servertime,
          clienttime: header.clienttime,
          at: header.at ?? { atrobotids: [] },
        },
        body:
          bodyItems.length > 0
            ? bodyItems
            : data.content != null && String(data.content).length > 0
              ? [{ type: "TEXT", content: String(data.content) }]
              : [],
      },
    };

    const dedupKey = preciseClientMsgId ?? preciseMessageId;
    const dedupKind: GroupInboundSeenKind = isMentionEvent ? "mention" : "forward";
    if (dedupKey && shouldSkipDuplicateGroupEvent(dedupKey, dedupKind)) {
      logVerbose(`[infoflow:ws] duplicate group message skipped: key=${dedupKey}, kind=${dedupKind}`);
      return;
    }
    logVerbose(
      `[infoflow:ws] group message: from=${header.fromuserid}, msgType=${header.msgtype}, groupId=${payload.groupid ?? payload.groupId}`,
    );

    await handleGroupChatMessage({
      cfg: this.options.config,
      msgData,
      accountId: this.options.account.accountId,
      statusSink: this.options.statusSink,
    });
  }

  private async handlePrivateEvent(data: Record<string, unknown>): Promise<void> {
    if (!data) return;

    this.options.statusSink?.({ lastInboundAt: Date.now() });

    const payload = (data.raw ?? data) as Record<string, unknown>;
    const originalMessage = (payload.originalMessage ?? payload) as Record<string, unknown>;

    const rawJson = (payload._rawJson ?? originalMessage._rawJson) as string | undefined;
    const preciseMsgId =
      (rawJson &&
        (extractIdFromRawJson(rawJson, "MsgId") ?? extractIdFromRawJson(rawJson, "msgId"))) ??
      (() => {
        const raw = payload.MsgId ?? payload.msgId ?? data.msgId ?? originalMessage.MsgId;
        return raw != null ? String(raw) : undefined;
      })();

    const preciseMsgId2 =
      (rawJson &&
        (extractIdFromRawJson(rawJson, "MsgId2") ??
          extractIdFromRawJson(rawJson, "msgid2") ??
          extractIdFromRawJson(rawJson, "msgId2"))) ??
      (() => {
        const raw =
          payload.MsgId2 ??
          payload.msgId2 ??
          payload.msgid2 ??
          data.MsgId2 ??
          data.msgid2 ??
          originalMessage.MsgId2;
        return raw != null ? String(raw) : undefined;
      })();

    const msgData: Record<string, unknown> = {
      FromUserId:
        payload.FromUserId ??
        payload.fromUserId ??
        data.fromUserId ??
        originalMessage.FromUserId ??
        "",
      FromUserName:
        payload.FromUserName ??
        payload.fromUserName ??
        data.fromUserName ??
        originalMessage.FromUserName,
      Content: payload.Content ?? payload.content ?? data.content ?? originalMessage.Content ?? "",
      MsgType:
        payload.MsgType ?? payload.msgType ?? data.msgType ?? originalMessage.MsgType ?? "text",
      CreateTime:
        payload.CreateTime ??
        payload.createTime ??
        data.createTime ??
        originalMessage.CreateTime ??
        String(Date.now()),
      PicUrl: payload.PicUrl ?? payload.picUrl ?? data.picUrl ?? originalMessage.PicUrl ?? "",
      VoiceUrl:
        payload.VoiceUrl ?? payload.voiceUrl ?? data.voiceUrl ?? originalMessage.VoiceUrl ?? "",
      FromPlatform:
        payload.FromPlatform ??
        payload.fromPlatform ??
        data.fromPlatform ??
        originalMessage.FromPlatform ??
        "",
      agentId: payload.agentId ?? data.agentId ?? originalMessage.agentId ?? "",
      OpenCode:
        payload.OpenCode ?? payload.openCode ?? data.openCode ?? originalMessage.OpenCode ?? "",
      MsgId: preciseMsgId,
      MsgId2: preciseMsgId2,
      FromId:
        payload.FromId ?? payload.fromid ?? data.FromId ?? data.fromid ?? originalMessage.FromId,
      Reply:
        payload.Reply ??
        payload.reply ??
        data.Reply ??
        data.reply ??
        originalMessage.Reply ??
        undefined,
      FileId: payload.FileId ?? payload.fileId ?? data.fileId ?? originalMessage.FileId,
      Name: payload.Name ?? payload.name ?? data.name ?? originalMessage.Name,
      FileSize: payload.FileSize ?? payload.fileSize ?? data.fileSize ?? originalMessage.FileSize,
      FileType: payload.FileType ?? payload.fileType ?? data.fileType ?? originalMessage.FileType,
      CardType: payload.CardType ?? payload.cardType ?? data.CardType ?? originalMessage.CardType,
      Title: payload.Title ?? payload.title ?? data.Title ?? originalMessage.Title,
    };

    if (isDuplicateMessage(msgData)) {
      logVerbose("[infoflow:ws] duplicate private message, skipping");
      return;
    }

    logVerbose(`[infoflow:ws] private message: from=${msgData.FromUserId}, msgType=${msgData.MsgType}`);

    await handlePrivateChatMessage({
      cfg: this.options.config,
      msgData,
      accountId: this.options.account.accountId,
      statusSink: this.options.statusSink,
    });
  }
}
