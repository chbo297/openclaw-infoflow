import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  recordPendingHistoryEntryIfEnabled,
  buildAgentMediaPayload,
} from "openclaw/plugin-sdk";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/mattermost";
import { resolveInfoflowAccount } from "./accounts.js";
import { getInfoflowBotLog, formatInfoflowError, logVerbose } from "./logging.js";
import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";
import { getInfoflowRuntime } from "./runtime.js";
import { findSentMessage } from "./sent-message-store.js";
import type {
  InfoflowChatType,
  InfoflowMessageEvent,
  InfoflowMentionIds,
  InfoflowReplyMode,
  InfoflowGroupConfig,
  HandleInfoflowMessageParams,
  HandlePrivateChatParams,
  HandleGroupChatParams,
  ResolvedInfoflowAccount,
} from "./types.js";

// Re-export types for external consumers
export type { InfoflowChatType, InfoflowMessageEvent } from "./types.js";

// ---------------------------------------------------------------------------
// @mention detection types and helpers
// ---------------------------------------------------------------------------

/**
 * Body item in Infoflow group message, supporting TEXT, AT, LINK types.
 * For AT items: robot mentions have `robotid` (number), human mentions have `userid` (string).
 * These two fields are mutually exclusive.
 */
type InfoflowBodyItem = {
  type?: string;
  content?: string;
  label?: string;
  /** 机器人 AT 时有此字段（数字），与 userid 互斥 */
  robotid?: number;
  /** AT 元素的显示名称 */
  name?: string;
  /** 人类用户 AT 时有此字段（uuap name），与 robotid 互斥 */
  userid?: string;
  /** IMAGE 类型 body item 的图片下载地址 */
  downloadurl?: string;
  /** replyData 类型 body item 中被引用消息的 ID */
  messageid?: string | number;
};

/**
 * Check if the bot was @mentioned in the message body.
 * Matches by robotName against the AT item's display name (case-insensitive).
 */
function checkBotMentioned(bodyItems: InfoflowBodyItem[], robotName?: string): boolean {
  if (!robotName) return false;
  const normalizedRobotName = robotName.toLowerCase();
  for (const item of bodyItems) {
    if (item.type !== "AT") continue;
    if (item.name?.toLowerCase() === normalizedRobotName) return true;
  }
  return false;
}

/**
 * Check if any entry in the watchlist was @mentioned in the message body.
 * Matching priority: userid > robotid (parsed as number) > name (fallback).
 * Returns the matched ID (from watchMentions), or undefined if none matched.
 */
function checkWatchMentioned(
  bodyItems: InfoflowBodyItem[],
  watchMentions: string[],
): string | undefined {
  if (!watchMentions.length) return undefined;
  const normalizedIds = watchMentions.map((n) => n.toLowerCase());
  // Pre-parse numeric entries for robotid matching
  const numericIds = watchMentions.map((n) => {
    const num = Number(n);
    return Number.isFinite(num) ? num : null;
  });

  for (const item of bodyItems) {
    if (item.type !== "AT") continue;

    // Priority 1: match userid (human AT)
    if (item.userid) {
      const idx = normalizedIds.indexOf(item.userid.toLowerCase());
      if (idx !== -1) return watchMentions[idx];
    }

    // Priority 2: match robotid (robot AT, watchMentions entry parsed as number)
    if (item.robotid != null) {
      const idx = numericIds.indexOf(item.robotid);
      if (idx !== -1) return watchMentions[idx];
    }

    // Priority 3: match by display name (fallback to name-based lookup)
    if (item.name) {
      const idx = normalizedIds.indexOf(item.name.toLowerCase());
      if (idx !== -1) return watchMentions[idx];
    }
  }
  return undefined;
}

/** Normalize watchRegex config to string[] (supports legacy single string). */
function normalizeWatchRegex(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Check if message content matches any of the configured watchRegex patterns. Uses "s" (dotAll) so that . matches newlines. */
function checkWatchRegex(mes: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "is").test(mes)) return true;
    } catch {
      // skip invalid pattern
    }
  }
  return false;
}

/** Return the first matching pattern index, or -1 if none match. Used for triggerReason and prompt. */
function findMatchingWatchRegex(mes: string, patterns: string[]): number {
  for (let i = 0; i < patterns.length; i++) {
    try {
      if (new RegExp(patterns[i], "is").test(mes)) return i;
    } catch {
      // skip invalid pattern
    }
  }
  return -1;
}

/**
 * Extract non-bot mention IDs from inbound group message body items.
 * Returns human userIds and robot agentIds (excluding the bot itself, matched by robotName).
 */
function extractMentionIds(bodyItems: InfoflowBodyItem[], robotName?: string): InfoflowMentionIds {
  const normalizedRobotName = robotName?.toLowerCase();
  const userIds: string[] = [];
  const agentIds: number[] = [];
  const seenUsers = new Set<string>();
  const seenAgents = new Set<number>();

  for (const item of bodyItems) {
    if (item.type !== "AT") continue;

    if (item.robotid != null) {
      // Skip the bot itself (matched by name)
      if (normalizedRobotName && item.name?.toLowerCase() === normalizedRobotName) continue;
      if (!seenAgents.has(item.robotid)) {
        seenAgents.add(item.robotid);
        agentIds.push(item.robotid);
      }
    } else if (item.userid) {
      const key = item.userid.toLowerCase();
      if (!seenUsers.has(key)) {
        seenUsers.add(key);
        userIds.push(item.userid);
      }
    }
  }
  return { userIds, agentIds };
}

/** Check if the message @mentions other bots or human users (excluding the bot itself). */
function hasOtherMentions(mentionIds?: InfoflowMentionIds): boolean {
  if (!mentionIds) return false;
  return mentionIds.userIds.length > 0 || mentionIds.agentIds.length > 0;
}

// ---------------------------------------------------------------------------
// Reply-to-bot detection (引用回复机器人消息)
// ---------------------------------------------------------------------------

/**
 * Check if the message is a reply (引用回复) to one of the bot's own messages.
 * Looks up replyData body items' messageid against the sent-message-store.
 */
function checkReplyToBot(bodyItems: InfoflowBodyItem[], accountId: string): boolean {
  for (const item of bodyItems) {
    if (item.type !== "replyData") continue;
    const msgId = item.messageid;
    if (msgId == null) continue;
    const msgIdStr = String(msgId);
    if (!msgIdStr) continue;
    try {
      const found = findSentMessage(accountId, msgIdStr);
      if (found) return true;
    } catch {
      // DB lookup failure should not block message processing
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared reply judgment rules (reused across prompt builders)
// ---------------------------------------------------------------------------

/** Shared judgment rules and reply format requirements for all conditional-reply prompts */
function buildReplyJudgmentRules(): string {
  return [
    "# Rules for Group Message Response",
    "",
    "## When to Reply",
    "",
    "Reply if ANY of the following is true:",
    "- The message is directed at you — either by explicit mention, or by contextual signals suggesting the user expects your response (e.g., a question following your previous reply, a topic clearly within your role, or conversational flow implying you are the intended recipient)",
    "- The message contains a clear question or request that you can answer using your knowledge, skills, tools, or reasoning",
    "- You have relevant domain expertise, documentation, or codebase context that adds value",
    "",
    "## When NOT to Reply — output only `NO_REPLY`",
    "",
    "Do NOT reply if ANY of the following is true:",
    "- The message is casual chatter, banter, emoji-only, or has no actionable question/request",
    "- The user explicitly indicates they don't want your response",
    "- The message is directed at another person, not at you",
    "- You lack the context or knowledge to give a useful answer (e.g., private/internal info you don't have access to)",
    "- The message intent is ambiguous and a wrong guess would be more disruptive than silence",
    "",
    "## Response Format",
    "",
    "- If you can answer: respond directly and concisely. Do not explain why you chose to answer. Do not add filler or pleasantries.",
    "- If you cannot answer: output exactly `NO_REPLY` — nothing else, no explanation, no apology.",
    "",
    "## Guiding Principle",
    "",
    "When in doubt, prefer silence (`NO_REPLY`). A missing reply is far less disruptive than an irrelevant or incorrect one in a group chat.",
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for watch-mention triggered messages.
 * Instructs the agent to reply only when confident, otherwise use NO_REPLY.
 */
function buildWatchMentionPrompt(mentionedId: string): string {
  return [
    `Someone in the group @mentioned ${mentionedId}. As ${mentionedId}'s assistant, you observed this message.`,
    "Decide whether you can answer on their behalf or provide help.",
    "",
    buildReplyJudgmentRules(),
    "",
    "# Examples",
    "",
    'Message: "What is 1+1?"',
    "→ 2",
    "",
    'Message: "What is the qt parameter for search requests in the client code?"',
    "(Assuming documentation records qt=s)",
    "→ According to the documentation, the qt parameter for search requests is qt=s",
    "",
    'Message: "asdfghjkl random gibberish"',
    "→ NO_REPLY",
    "",
    'Message: "Can you check today\'s release progress?"',
    "(Assuming no relevant information available)",
    "→ NO_REPLY",
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for watch-content triggered messages.
 * Instructs the agent to reply only when confident, otherwise use NO_REPLY.
 */
function buildWatchRegexPrompt(patterns: string[]): string {
  const label = patterns.length ? `(${patterns.join(" | ")})` : "";
  return [
    `The message content matched one of the configured watch patterns ${label}.`,
    "As the group assistant, you observed this message. Decide whether you can provide help or a valuable reply.",
    "",
    buildReplyJudgmentRules(),
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for follow-up replies after bot's last response.
 * Uses three-tier semantic priority: (1) intent to talk to bot → must reply,
 * (2) explicit stop request → must not reply, (3) topic continuity judgment.
 *
 * When isReplyToBot is true, injects a strong signal that the user quoted the bot's message.
 */
function buildFollowUpPrompt(isReplyToBot: boolean): string {
  const lines: string[] = [
    "You just replied to a message in this group. Someone has now sent a new message.",
    "Follow the priority rules below **in order** to decide whether to reply.",
    "",
  ];

  if (isReplyToBot) {
    lines.push(
      "**Important context: this message is a quoted reply to your previous message. This is a strong signal that the user is following up with you.**",
      "",
    );
  }

  lines.push(
    "# Priority 1: The sender intends to talk to you → MUST reply",
    "",
    "Based on semantic analysis, if the sender shows ANY of the following intents or expectations, you **MUST** reply (do NOT output NO_REPLY):",
    "- Asking a follow-up question about your previous answer (e.g. 'why?', 'what else?', 'what if...?')",
    "- Quoted/replied to your message (indicating a conversation with you)",
    "- Addressing you by name, or using words like 'bot', 'assistant', etc.",
    "- Requesting you to do something (e.g. 'help me...', 'explain...', 'translate...')",
    "- Semantically expects a reply from you",
    "",
    "# Priority 2: Explicitly asking you to stop → MUST NOT reply",
    "",
    "If the message explicitly tells you to stop replying (e.g. 'shut up', 'stop', 'don't reply',",
    "'no need for bot', or equivalent expressions in any language),",
    "output only NO_REPLY.",
    "",
    "# Priority 3: No explicit intent → Judge topic continuity",
    "",
    "If neither Priority 1 nor Priority 2 applies:",
    "- If the message continues the same topic you previously replied to, and you can provide valuable help → reply.",
    "- If it is a new/unrelated topic, or you cannot add value → output only NO_REPLY.",
    "",
    buildReplyJudgmentRules(),
  );

  return lines.join("\n");
}

/**
 * Build a GroupSystemPrompt for follow-up messages that @mention another person or bot.
 * Uses the conservative ReplyJudgmentRules since the message is likely directed at someone else.
 */
function buildFollowUpOtherMentionedPrompt(): string {
  return [
    "You recently replied in this group. A new message has arrived, but it @mentions another person or bot — it is likely directed at them, not at you.",
    "",
    buildReplyJudgmentRules(),
  ].join("\n");
}

/**
 * Build a GroupSystemPrompt for proactive mode.
 * Instructs the agent to think about the message and reply when helpful.
 */
function buildProactivePrompt(): string {
  return [
    "You observed this message in the group. Decide whether you can provide help or a valuable reply.",
    "If you need more context or clarification, you may ask follow-up questions.",
    "",
    buildReplyJudgmentRules(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Group reply tracking (in-memory) for follow-up window
// ---------------------------------------------------------------------------

/** In-memory map tracking bot's last reply timestamp per group */
const groupLastReplyMap = new Map<string, number>();

/** In-memory map accumulating recent group messages for context injection when bot is @mentioned */
const chatHistories = new Map<string, HistoryEntry[]>();

/** Record that the bot replied to a group (called after successful send) */
export function recordGroupReply(groupId: string): void {
  groupLastReplyMap.set(groupId, Date.now());
}

/** Check if a group is within the follow-up window */
function isWithinFollowUpWindow(groupId: string, windowSeconds: number): boolean {
  const lastReply = groupLastReplyMap.get(groupId);
  if (!lastReply) return false;
  return Date.now() - lastReply < windowSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Group config resolution
// ---------------------------------------------------------------------------

type ResolvedGroupConfig = {
  replyMode: InfoflowReplyMode;
  followUp: boolean;
  followUpWindow: number;
  watchMentions: string[];
  watchRegex: string[];
  systemPrompt?: string;
};

/** Infer replyMode from legacy requireMention + watchMentions fields */
function inferLegacyReplyMode(account: ResolvedInfoflowAccount): InfoflowReplyMode {
  const requireMention = account.config.requireMention !== false;
  const hasWatch = (account.config.watchMentions ?? []).length > 0;
  if (!requireMention) return "proactive";
  if (hasWatch) return "mention-and-watch";
  return "mention-only";
}

/** Resolve effective group config by merging group-level → account-level → legacy defaults */
function resolveGroupConfig(
  account: ResolvedInfoflowAccount,
  groupId?: number,
): ResolvedGroupConfig {
  const groupCfg: InfoflowGroupConfig | undefined =
    groupId != null ? account.config.groups?.[String(groupId)] : undefined;
  return {
    replyMode: groupCfg?.replyMode ?? account.config.replyMode ?? inferLegacyReplyMode(account),
    followUp: groupCfg?.followUp ?? account.config.followUp ?? true,
    followUpWindow: groupCfg?.followUpWindow ?? account.config.followUpWindow ?? 300,
    watchMentions: groupCfg?.watchMentions ?? account.config.watchMentions ?? [],
    watchRegex: normalizeWatchRegex(groupCfg?.watchRegex ?? account.config.watchRegex),
    systemPrompt: groupCfg?.systemPrompt,
  };
}

/**
 * Handles an incoming private chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handlePrivateChatMessage(params: HandlePrivateChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;

  // Extract sender and content from msgData (flexible field names)
  const fromuser = String(msgData.FromUserId ?? msgData.fromuserid ?? msgData.from ?? "");
  const mes = String(msgData.Content ?? msgData.content ?? msgData.text ?? msgData.mes ?? "");

  // Extract sender name (FromUserName is more human-readable than FromUserId)
  const senderName = String(msgData.FromUserName ?? msgData.username ?? fromuser);

  // Extract message ID for dedup tracking
  const messageId = msgData.MsgId ?? msgData.msgid ?? msgData.messageid;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  // Extract timestamp (CreateTime is in seconds, convert to milliseconds)
  const createTime = msgData.CreateTime ?? msgData.createtime;
  const timestamp = createTime != null ? Number(createTime) * 1000 : Date.now();

  // Detect image messages: MsgType=image with PicUrl
  const msgType = String(msgData.MsgType ?? msgData.msgtype ?? "");
  const picUrl = String(msgData.PicUrl ?? msgData.picurl ?? "");
  const imageUrls: string[] = [];
  if (msgType === "image" && picUrl.trim()) {
    imageUrls.push(picUrl.trim());
  }

  logVerbose(
    `[infoflow] private chat: fromuser=${fromuser}, senderName=${senderName}, mes=${mes}, msgType=${msgType}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser || (!mes.trim() && imageUrls.length === 0)) {
    return;
  }

  // For image-only messages (no text), use placeholder
  let effectiveMes = mes.trim();
  if (!effectiveMes && imageUrls.length > 0) {
    effectiveMes = "<media:image>";
  }

  // Delegate to the common message handler (private chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes: effectiveMes,
      chatType: "direct",
      senderName,
      messageId: messageIdStr,
      timestamp,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    },
    accountId,
    statusSink,
  });
}

/**
 * Handles an incoming group chat message from Infoflow.
 * Receives the raw decrypted message data and dispatches to the agent.
 */
export async function handleGroupChatMessage(params: HandleGroupChatParams): Promise<void> {
  const { cfg, msgData, accountId, statusSink } = params;

  // Extract sender from nested structure or flat fields.
  // Some Infoflow events (including bot-authored forwards) only populate `fromid` on the root,
  // so include msgData.fromid as a final fallback.
  const header = (msgData.message as Record<string, unknown>)?.header as
    | Record<string, unknown>
    | undefined;
  const fromuser = String(
    header?.fromuserid ?? msgData.fromuserid ?? msgData.from ?? msgData.fromid ?? "",
  );

  // Extract message ID (priority: header.messageid > header.msgid > MsgId)
  const messageId = header?.messageid ?? header?.msgid ?? msgData.MsgId;
  const messageIdStr = messageId != null ? String(messageId) : undefined;

  const rawGroupId = msgData.groupid ?? header?.groupid;
  const groupid =
    typeof rawGroupId === "number" ? rawGroupId : rawGroupId ? Number(rawGroupId) : undefined;

  // Extract timestamp (time is in milliseconds)
  const rawTime = msgData.time ?? header?.servertime;
  const timestamp = rawTime != null ? Number(rawTime) : Date.now();

  logVerbose(
    `[infoflow] group chat: fromuser=${fromuser}, groupid=${groupid}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser) {
    return;
  }

  // Extract message content from body array or flat content field
  const message = msgData.message as Record<string, unknown> | undefined;
  const bodyItems = (message?.body ?? msgData.body ?? []) as InfoflowBodyItem[];

  // Resolve account to get robotName for mention detection
  const account = resolveInfoflowAccount({ cfg, accountId });
  const robotName = account.config.robotName;

  // Check if bot was @mentioned (by robotName)
  const wasMentioned = checkBotMentioned(bodyItems, robotName);

  // Extract non-bot mention IDs (userIds + agentIds) for LLM-driven @mentions
  const mentionIds = extractMentionIds(bodyItems, robotName);

  // Build two versions: mes (for CommandBody, no @xxx) and rawMes (for RawBody, with @xxx)
  let textContent = "";
  let rawTextContent = "";
  const replyContextItems: string[] = [];
  const imageUrls: string[] = [];
  if (Array.isArray(bodyItems)) {
    for (const item of bodyItems) {
      if (item.type === "replyData") {
        // 引用回复：提取被引用消息的内容（可能有多条引用）
        const replyBody = (item.content ?? "").trim();
        if (replyBody) {
          replyContextItems.push(replyBody);
        }
      } else if (item.type === "TEXT" || item.type === "MD") {
        textContent += item.content ?? "";
        rawTextContent += item.content ?? "";
      } else if (item.type === "LINK") {
        const label = item.label ?? "";
        if (label) {
          textContent += ` ${label} `;
          rawTextContent += ` ${label} `;
        }
      } else if (item.type === "AT") {
        // AT elements only go into rawTextContent, not textContent
        const name = item.name ?? "";
        if (name) {
          rawTextContent += `@${name} `;
        }
      } else if (item.type === "IMAGE") {
        // 提取图片下载地址
        const url = item.downloadurl;
        if (typeof url === "string" && url.trim()) {
          imageUrls.push(url.trim());
        }
      } else if (typeof item.content === "string" && item.content.trim()) {
        // Fallback: for any other item types with string content, treat content as text.
        textContent += item.content;
        rawTextContent += item.content;
      }
    }
  }

  let mes = textContent.trim() || String(msgData.content ?? msgData.text ?? "");
  const rawMes = rawTextContent.trim() || mes;

  const replyContext = replyContextItems.length > 0 ? replyContextItems : undefined;

  if (!mes && !replyContext && imageUrls.length === 0) {
    return;
  }
  // 纯图片消息：设置占位符
  if (!mes && imageUrls.length > 0) {
    mes = `<media:image>${imageUrls.length > 1 ? ` (${imageUrls.length} images)` : ""}`;
  }
  // If mes is empty but replyContext exists, use a placeholder so the message is not dropped
  if (!mes && replyContext) {
    mes = "(引用回复)";
  }

  // Extract sender name from header or fallback to fromuser
  const senderName = String(header?.username ?? header?.nickname ?? msgData.username ?? fromuser);

  // Detect reply-to-bot: check if any replyData item quotes a bot-sent message
  const isReplyToBot = replyContext ? checkReplyToBot(bodyItems, accountId) : false;

  // Delegate to the common message handler (group chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      rawMes,
      chatType: "group",
      groupId: groupid,
      senderName,
      wasMentioned,
      messageId: messageIdStr,
      timestamp,
      bodyItems,
      mentionIds:
        mentionIds.userIds.length > 0 || mentionIds.agentIds.length > 0 ? mentionIds : undefined,
      replyContext,
      isReplyToBot: isReplyToBot || undefined,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    },
    accountId,
    statusSink,
  });
}

/**
 * Resolves route, builds envelope, records session meta, and dispatches reply for one incoming Infoflow message.
 * Called from monitor after webhook request is validated.
 */
export async function handleInfoflowMessage(params: HandleInfoflowMessageParams): Promise<void> {
  const { cfg, event, accountId, statusSink } = params;
  const { fromuser, mes, chatType, groupId, senderName } = event;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const core = getInfoflowRuntime();

  const isGroup = chatType === "group";
  // Convert groupId (number) to string for peerId since routing expects string
  const peerId = isGroup ? (groupId !== undefined ? String(groupId) : fromuser) : fromuser;

  // Resolve per-group config for replyMode gating
  const groupCfg = isGroup ? resolveGroupConfig(account, groupId) : undefined;

  // "ignore" mode: discard immediately, no save, no think, no reply
  if (isGroup && groupCfg?.replyMode === "ignore") {
    return;
  }

  // Resolve route based on chat type
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "infoflow",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Build conversation label and from address based on chat type
  const fromLabel = isGroup ? `group:${groupId}` : senderName || fromuser;
  const fromAddress = isGroup ? `infoflow:group:${groupId}` : `infoflow:${fromuser}`;
  const toAddress = isGroup ? `infoflow:group:${groupId}` : `infoflow:${fromuser}`;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Infoflow",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: mes,
  });

  // Inject accumulated group chat history into the body for context
  const historyKey = isGroup && groupId !== undefined ? String(groupId) : undefined;
  let combinedBody = body;
  if (isGroup && historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: chatHistories,
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
      currentMessage: body,
      formatEntry: (entry) =>
        core.channel.reply.formatAgentEnvelope({
          channel: "Infoflow",
          from: entry.sender,
          timestamp: entry.timestamp ?? Date.now(),
          body: entry.body,
        }),
    });
  }

  const inboundHistory =
    isGroup && historyKey
      ? (chatHistories.get(historyKey) ?? []).map((e) => ({
          sender: e.sender,
          body: e.body,
          timestamp: e.timestamp,
        }))
      : undefined;

  // --- Resolve inbound media (images) ---
  const INFOFLOW_MAX_IMAGES = 20;
  const mediaMaxBytes = 30 * 1024 * 1024; // 30MB default, matching Feishu
  const mediaList: Array<{ path: string; contentType?: string }> = [];
  const failReasons: string[] = [];

  if (event.imageUrls && event.imageUrls.length > 0) {
    // Collect unique hostnames from image URLs for SSRF allowlist.
    // Infoflow image servers (e.g. xp2.im.baidu.com, e4hi.im.baidu.com) resolve to
    // internal IPs on Baidu's network, so they need to be explicitly allowed.
    const allowedHostnames: string[] = [];
    for (const imageUrl of event.imageUrls) {
      try {
        const hostname = new URL(imageUrl).hostname;
        if (hostname && !allowedHostnames.includes(hostname)) {
          allowedHostnames.push(hostname);
        }
      } catch {
        // invalid URL, will fail at fetch time
      }
    }
    const ssrfPolicy = allowedHostnames.length > 0 ? { allowedHostnames } : undefined;

    const urls = event.imageUrls.slice(0, INFOFLOW_MAX_IMAGES);
    const results = await Promise.allSettled(
      urls.map(async (imageUrl) => {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: imageUrl,
          maxBytes: mediaMaxBytes,
          ssrfPolicy,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        logVerbose(`[infoflow] downloaded image from ${imageUrl}, saved to ${saved.path}`);
        return { path: saved.path, contentType: saved.contentType ?? fetched.contentType };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        mediaList.push(result.value);
      } else {
        const reason = String(result.reason);
        logVerbose(`[infoflow] failed to download image: ${reason}`);
        failReasons.push(reason);
      }
    }
  }

  const mediaPayload = buildAgentMediaPayload(mediaList);

  // If user sent images but some/all downloads failed, adjust the body to inform the LLM.
  const requestedImageCount = event.imageUrls?.length ?? 0;
  const downloadedImageCount = mediaList.length;
  const failedImageCount = requestedImageCount - downloadedImageCount;
  if (requestedImageCount > 0 && failedImageCount > 0) {
    // Deduplicate error reasons and truncate for readability
    const uniqueReasons = [...new Set(failReasons)];
    const reasonSummary = uniqueReasons.map((r) => r.slice(0, 200)).join("; ");

    if (downloadedImageCount === 0) {
      // All failed
      const failNote =
        `[The user sent ${requestedImageCount > 1 ? `${requestedImageCount} images` : "an image"}, ` +
        `but failed to load: ${reasonSummary}]`;
      if (combinedBody.includes("<media:image>")) {
        combinedBody = combinedBody.replace(/<media:image>(\s*\(\d+ images\))?/, failNote);
      } else {
        combinedBody += `\n\n${failNote}`;
      }
    } else {
      // Partial failure: some images loaded, some didn't
      const failNote = `[${failedImageCount} of ${requestedImageCount} images failed to load: ${reasonSummary}]`;
      combinedBody += `\n\n${failNote}`;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: combinedBody,
    RawBody: event.rawMes ?? mes,
    CommandBody: mes,
    From: fromAddress,
    To: toAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? `group:${groupId}` : undefined,
    SenderName: senderName || fromuser,
    SenderId: fromuser,
    Provider: "infoflow",
    Surface: "infoflow",
    MessageSid: event.messageId ?? `${Date.now()}`,
    Timestamp: event.timestamp ?? Date.now(),
    OriginatingChannel: "infoflow",
    OriginatingTo: toAddress,
    WasMentioned: isGroup ? event.wasMentioned : undefined,
    ReplyToBody: event.replyContext ? event.replyContext.join("\n---\n") : undefined,
    InboundHistory: inboundHistory,
    CommandAuthorized: true,
    ...mediaPayload,
  });

  // Record session using recordInboundSession for proper session tracking
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      getInfoflowBotLog().error(
        `[infoflow] failed updating session meta (sessionKey=${route.sessionKey}, accountId=${accountId}): ${formatInfoflowError(err)}`,
      );
    },
  });

  // Reply mode gating for group messages
  // Session is already recorded above for context history
  let triggerReason = "direct-message";
  if (isGroup && groupCfg) {
    const { replyMode } = groupCfg;
    const groupIdStr = groupId !== undefined ? String(groupId) : undefined;

    // "record" mode: save to session only, no think, no reply
    if (replyMode === "record") {
      if (groupIdStr) {
        logVerbose(
          `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=record-mode`,
        );
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: groupIdStr,
          entry: { sender: senderName || fromuser, body: mes, timestamp: Date.now() },
          limit: DEFAULT_GROUP_HISTORY_LIMIT,
        });
      }
      return;
    }

    const canDetectMention = Boolean(account.config.robotName);
    const wasMentioned = event.wasMentioned === true;

    if (replyMode === "mention-only") {
      // Only reply if bot was @mentioned
      const shouldReply = canDetectMention && wasMentioned;
      if (shouldReply) {
        triggerReason = "bot-mentioned";
      } else {
        // Check follow-up window: if bot recently replied, allow LLM to decide
        if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          if (hasOtherMentions(event.mentionIds)) {
            triggerReason = "followUp-other-mentioned";
            ctxPayload.GroupSystemPrompt = buildFollowUpOtherMentionedPrompt();
          } else {
            triggerReason = "followUp";
            ctxPayload.GroupSystemPrompt = buildFollowUpPrompt(event.isReplyToBot === true);
          }
        } else {
          if (groupIdStr) {
            logVerbose(
              `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=mention-only-not-mentioned`,
            );
            recordPendingHistoryEntryIfEnabled({
              historyMap: chatHistories,
              historyKey: groupIdStr,
              entry: { sender: senderName || fromuser, body: mes, timestamp: Date.now() },
              limit: DEFAULT_GROUP_HISTORY_LIMIT,
            });
          }
          return;
        }
      }
    } else if (replyMode === "mention-and-watch") {
      // Reply if bot @mentioned, or if watched person @mentioned, or follow-up
      const botMentioned = canDetectMention && wasMentioned;
      if (botMentioned) {
        triggerReason = "bot-mentioned";
      } else {
        // Check watch-mention
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;

        if (matchedWatchId) {
          triggerReason = `watchMentions(${matchedWatchId})`;
          // Watch-mention triggered: instruct agent to reply only if confident
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else if (groupCfg.watchRegex.length > 0 && checkWatchRegex(mes, groupCfg.watchRegex)) {
          const idx = findMatchingWatchRegex(mes, groupCfg.watchRegex);
          triggerReason =
            idx >= 0
              ? `watchRegex(${groupCfg.watchRegex[idx]})`
              : `watchRegex(${groupCfg.watchRegex.join("|")})`;
          // Watch-content triggered: message matched one of the configured regex patterns
          ctxPayload.GroupSystemPrompt = buildWatchRegexPrompt(groupCfg.watchRegex);
        } else if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          if (hasOtherMentions(event.mentionIds)) {
            triggerReason = "followUp-other-mentioned";
            ctxPayload.GroupSystemPrompt = buildFollowUpOtherMentionedPrompt();
          } else {
            triggerReason = "followUp";
            ctxPayload.GroupSystemPrompt = buildFollowUpPrompt(event.isReplyToBot === true);
          }
        } else {
          if (groupIdStr) {
            logVerbose(
              `[infoflow:bot] pending: from=${fromuser}, group=${groupId}, reason=mention-and-watch-no-trigger`,
            );
            recordPendingHistoryEntryIfEnabled({
              historyMap: chatHistories,
              historyKey: groupIdStr,
              entry: { sender: senderName || fromuser, body: mes, timestamp: Date.now() },
              limit: DEFAULT_GROUP_HISTORY_LIMIT,
            });
          }
          return;
        }
      }
    } else if (replyMode === "proactive") {
      // Always think and potentially reply
      const botMentioned = canDetectMention && wasMentioned;
      if (botMentioned) {
        triggerReason = "bot-mentioned";
      } else {
        // Check watch-mention first (higher priority prompt)
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;
        if (matchedWatchId) {
          triggerReason = `watchMentions(${matchedWatchId})`;
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else {
          triggerReason = "proactive";
          ctxPayload.GroupSystemPrompt = buildProactivePrompt();
        }
      }
    }

    // Inject per-group systemPrompt (append, don't replace)
    if (groupCfg.systemPrompt) {
      const existing = ctxPayload.GroupSystemPrompt ?? "";
      ctxPayload.GroupSystemPrompt = existing
        ? `${existing}\n\n---\n\n${groupCfg.systemPrompt}`
        : groupCfg.systemPrompt;
    }
  }

  // Build unified target: "group:<id>" for group chat, username for private chat
  const to = isGroup && groupId !== undefined ? `group:${groupId}` : fromuser;

  // Provide mention context to the LLM so it can decide who to @mention
  if (isGroup && event.mentionIds) {
    const parts: string[] = [];
    if (event.mentionIds.userIds.length > 0) {
      parts.push(`User IDs: ${event.mentionIds.userIds.join(", ")}`);
    }
    if (event.mentionIds.agentIds.length > 0) {
      parts.push(`Bot IDs: ${event.mentionIds.agentIds.join(", ")}`);
    }
    if (parts.length > 0) {
      ctxPayload.Body += `\n\n[System: @mentioned in group: ${parts.join("; ")}. To @mention someone in your reply, use the @id format]`;
    }
  }

  logVerbose(
    `[infoflow:bot] dispatching to LLM: from=${fromuser}, group=${groupId ?? "N/A"}, trigger=${triggerReason}, replyMode=${groupCfg?.replyMode ?? "N/A"}`,
  );

  const { dispatcherOptions, replyOptions } = createInfoflowReplyDispatcher({
    cfg,
    agentId: route.agentId,
    accountId: account.accountId,
    to,
    statusSink,
    // @mention the sender back when bot was directly @mentioned in a group
    atOptions: isGroup && event.wasMentioned ? { atUserIds: [fromuser] } : undefined,
    // Pass mention IDs for LLM-driven @mention resolution in outbound text
    mentionIds: isGroup ? event.mentionIds : undefined,
    // Pass inbound messageId for outbound reply-to (group only)
    replyToMessageId: isGroup ? event.messageId : undefined,
    replyToPreview: isGroup ? mes : undefined,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, route.agentId),
  });

  const dispatchResult = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions,
    replyOptions,
  });

  const didReply = dispatchResult?.queuedFinal ?? false;

  // Clear accumulated history after dispatch (it's now in the session transcript)
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({
      historyMap: chatHistories,
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
    });
  }

  // Record bot reply timestamp for follow-up window tracking
  if (didReply && isGroup && groupId !== undefined) {
    recordGroupReply(String(groupId));
  }

  logVerbose(
    `[infoflow] dispatch complete: ${chatType} from ${fromuser}, replied=${didReply}, finalCount=${dispatchResult?.counts.final ?? 0}, hasGroupSystemPrompt=${Boolean(ctxPayload.GroupSystemPrompt)}`,
  );
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Check if bot was mentioned in message body. Only exported for tests. */
export const _checkBotMentioned = checkBotMentioned;

/** @internal — Check if any watch-list name was @mentioned. Only exported for tests. */
export const _checkWatchMentioned = checkWatchMentioned;

/** @internal — Extract non-bot mention IDs. Only exported for tests. */
export const _extractMentionIds = extractMentionIds;

/** @internal — Check if message matches any watchRegex pattern (dotAll). Only exported for tests. */
export const _checkWatchRegex = checkWatchRegex;

/** @internal — Check if message is a reply to one of the bot's own messages. Only exported for tests. */
export const _checkReplyToBot = checkReplyToBot;
