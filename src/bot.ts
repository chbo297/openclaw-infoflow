import { resolveInfoflowAccount } from "./accounts.js";
import { getInfoflowBotLog, formatInfoflowError, logVerbose } from "./logging.js";
import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";
import { getInfoflowRuntime } from "./runtime.js";
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

// ---------------------------------------------------------------------------
// Shared reply judgment rules (reused across prompt builders)
// ---------------------------------------------------------------------------

/** Shared judgment rules and reply format requirements for all conditional-reply prompts */
function buildReplyJudgmentRules(): string {
  return [
    "# Rules",
    "",
    "## Can answer or help → Reply directly",
    "",
    "Reply if ANY of these apply:",
    "- The question can be answered through common sense or logical reasoning (e.g. math, general knowledge)",
    "- You can find relevant clues or content in your knowledge base, documentation, or code",
    "- You have sufficient domain expertise to provide a valuable reference",
    "",
    "## Cannot answer → Reply with NO_REPLY only",
    "",
    "Do NOT reply if ANY of these apply:",
    "- The message contains no clear question or request (e.g. casual chat, meaningless content)",
    "- The question involves private information or context you have no knowledge of",
    "- You cannot understand the core intent of the message",
    "",
    "# Response format",
    "",
    "- When you can answer: give a direct, concise answer. Do not explain why you chose to answer.",
    "- When you cannot answer: output only NO_REPLY with no other text.",
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
 * Build a GroupSystemPrompt for follow-up replies after bot's last response.
 * Instructs the agent to reply only if the message is a follow-up on the same topic.
 */
function buildFollowUpPrompt(): string {
  return [
    "You just replied to a message in this group. Someone has now sent a new message.",
    "First determine if this message is a follow-up or continuation of the same topic you previously replied to, then decide if you can continue to help.",
    "",
    "Note: If this message is clearly a new topic or unrelated to your previous reply, respond with NO_REPLY.",
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

  logVerbose(
    `[infoflow] private chat: fromuser=${fromuser}, senderName=${senderName}, raw msgData: ${JSON.stringify(msgData)}`,
  );

  if (!fromuser || !mes.trim()) {
    return;
  }

  // Delegate to the common message handler (private chat)
  await handleInfoflowMessage({
    cfg,
    event: {
      fromuser,
      mes,
      chatType: "direct",
      senderName,
      messageId: messageIdStr,
      timestamp,
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

  // Extract sender from nested structure or flat fields
  const header = (msgData.message as Record<string, unknown>)?.header as
    | Record<string, unknown>
    | undefined;
  const fromuser = String(header?.fromuserid ?? msgData.fromuserid ?? msgData.from ?? "");

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
  if (Array.isArray(bodyItems)) {
    for (const item of bodyItems) {
      if (item.type === "TEXT") {
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
      }
    }
  }

  const mes = textContent.trim() || String(msgData.content ?? msgData.text ?? "");
  const rawMes = rawTextContent.trim() || mes;

  if (!mes) {
    return;
  }

  // Extract sender name from header or fallback to fromuser
  const senderName = String(header?.username ?? header?.nickname ?? msgData.username ?? fromuser);

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
  const toAddress = isGroup ? `infoflow:${groupId}` : `infoflow:${account.accountId}`;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Infoflow",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: mes,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
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
    CommandAuthorized: true,
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
  if (isGroup && groupCfg) {
    const { replyMode } = groupCfg;
    const groupIdStr = groupId !== undefined ? String(groupId) : undefined;

    // "record" mode: save to session only, no think, no reply
    if (replyMode === "record") {
      return;
    }

    const canDetectMention = Boolean(account.config.robotName);
    const wasMentioned = event.wasMentioned === true;

    if (replyMode === "mention-only") {
      // Only reply if bot was @mentioned
      const shouldReply = canDetectMention && wasMentioned;
      if (!shouldReply) {
        // Check follow-up window: if bot recently replied, allow LLM to decide
        if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          ctxPayload.GroupSystemPrompt = buildFollowUpPrompt();
        } else {
          return;
        }
      }
    } else if (replyMode === "mention-and-watch") {
      // Reply if bot @mentioned, or if watched person @mentioned, or follow-up
      const botMentioned = canDetectMention && wasMentioned;
      if (!botMentioned) {
        // Check watch-mention
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;

        if (matchedWatchId) {
          // Watch-mention triggered: instruct agent to reply only if confident
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else if (
          groupCfg.followUp &&
          groupIdStr &&
          isWithinFollowUpWindow(groupIdStr, groupCfg.followUpWindow)
        ) {
          // Follow-up window: let LLM decide if this is a follow-up
          ctxPayload.GroupSystemPrompt = buildFollowUpPrompt();
        } else {
          return;
        }
      }
    } else if (replyMode === "proactive") {
      // Always think and potentially reply
      const botMentioned = canDetectMention && wasMentioned;
      if (!botMentioned) {
        // Check watch-mention first (higher priority prompt)
        const watchMentions = groupCfg.watchMentions;
        const matchedWatchId =
          watchMentions.length > 0 && event.bodyItems
            ? checkWatchMentioned(event.bodyItems, watchMentions)
            : undefined;
        if (matchedWatchId) {
          ctxPayload.GroupSystemPrompt = buildWatchMentionPrompt(matchedWatchId);
        } else {
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
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions,
    replyOptions,
  });

  // Record bot reply timestamp for follow-up window tracking
  if (isGroup && groupId !== undefined) {
    recordGroupReply(String(groupId));
  }

  logVerbose(
    `[infoflow] dispatch complete: ${chatType} from ${fromuser}, hasGroupSystemPrompt=${Boolean(ctxPayload.GroupSystemPrompt)}`,
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
