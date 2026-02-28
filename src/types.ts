/**
 * Infoflow channel type definitions.
 */

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type InfoflowDmPolicy = "open" | "pairing" | "allowlist";
export type InfoflowGroupPolicy = "open" | "allowlist" | "disabled";
export type InfoflowChatType = "direct" | "group";

/** Reply mode controlling bot behavior per group */
export type InfoflowReplyMode =
  | "ignore"
  | "record"
  | "mention-only"
  | "mention-and-watch"
  | "proactive";

/** Per-group configuration overrides */
export type InfoflowGroupConfig = {
  replyMode?: InfoflowReplyMode;
  watchMentions?: string[];
  followUp?: boolean;
  followUpWindow?: number;
  systemPrompt?: string;
};

// ---------------------------------------------------------------------------
// Inbound body item (for @mention detection in received messages)
// ---------------------------------------------------------------------------

/** Inbound body item from group messages (for @mention detection) */
export type InfoflowInboundBodyItem = {
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

/** Mention IDs extracted from inbound group AT items (excluding the bot itself) */
export type InfoflowMentionIds = {
  /** Human user userid list */
  userIds: string[];
  /** Robot robotid list (numbers, corresponding to outbound atagentids) */
  agentIds: number[];
};

// ---------------------------------------------------------------------------
// AT mention types
// ---------------------------------------------------------------------------

/** AT mention options for @mentioning members in group messages */
export type InfoflowAtOptions = {
  /** @all members; when true, atUserIds is ignored */
  atAll?: boolean;
  /** List of user IDs (uuapName) to @mention */
  atUserIds?: string[];
};

/** Group message body item type */
export type InfoflowGroupMessageBodyItem =
  | { type: "TEXT"; content: string }
  | { type: "MD"; content: string }
  | { type: "AT"; atall?: boolean; atuserids: string[]; atagentids?: number[] }
  | { type: "LINK"; href: string };

/** Content item for sendInfoflowMessage */
export type InfoflowMessageContentItem = {
  type: "text" | "markdown" | "at" | "at-agent" | "link";
  content: string;
};

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

export type InfoflowAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiHost?: string;
  checkToken?: string;
  encodingAESKey?: string;
  appKey?: string;
  appSecret?: string;
  dmPolicy?: InfoflowDmPolicy;
  allowFrom?: string[];
  groupPolicy?: InfoflowGroupPolicy;
  groupAllowFrom?: string[];
  requireMention?: boolean;
  /** Robot name for matching @mentions in group messages */
  robotName?: string;
  /** Names to watch for @mentions; when someone @mentions a person in this list,
   *  the bot analyzes the message and replies only if confident. */
  watchMentions?: string[];
  /** Reply mode controlling bot engagement level in groups */
  replyMode?: InfoflowReplyMode;
  /** Enable follow-up replies after bot responds to a mention (default: true) */
  followUp?: boolean;
  /** Follow-up window in seconds after last bot reply (default: 300) */
  followUpWindow?: number;
  /** Per-group configuration overrides, keyed by group ID */
  groups?: Record<string, InfoflowGroupConfig>;
  accounts?: Record<string, InfoflowAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedInfoflowAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    enabled?: boolean;
    name?: string;
    apiHost: string;
    checkToken: string;
    encodingAESKey: string;
    appKey: string;
    appSecret: string;
    dmPolicy?: InfoflowDmPolicy;
    allowFrom?: string[];
    groupPolicy?: InfoflowGroupPolicy;
    groupAllowFrom?: string[];
    requireMention?: boolean;
    /** Robot name for matching @mentions in group messages */
    robotName?: string;
    /** Names to watch for @mentions; when someone @mentions a person in this list,
     *  the bot analyzes the message and replies only if confident. */
    watchMentions?: string[];
    /** Reply mode controlling bot engagement level in groups */
    replyMode?: InfoflowReplyMode;
    /** Enable follow-up replies after bot responds to a mention (default: true) */
    followUp?: boolean;
    /** Follow-up window in seconds after last bot reply (default: 300) */
    followUpWindow?: number;
    /** Per-group configuration overrides, keyed by group ID */
    groups?: Record<string, InfoflowGroupConfig>;
  };
};

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type InfoflowMessageEvent = {
  fromuser: string;
  mes: string;
  chatType: InfoflowChatType;
  groupId?: number;
  senderName?: string;
  /** Whether the bot was @mentioned in the message */
  wasMentioned?: boolean;
  /** Original message ID from Infoflow */
  messageId?: string;
  /** Unix millisecond timestamp of the message */
  timestamp?: number;
  /** Raw message text preserving @mentions (for RawBody) */
  rawMes?: string;
  /** Raw body items from group message (for watch-mention detection) */
  bodyItems?: InfoflowInboundBodyItem[];
  /** Non-bot mention IDs extracted from AT items in group messages (excluding bot itself) */
  mentionIds?: InfoflowMentionIds;
};

// ---------------------------------------------------------------------------
// Handler parameter types
// ---------------------------------------------------------------------------

export type HandleInfoflowMessageParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  event: InfoflowMessageEvent;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type HandlePrivateChatParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  msgData: Record<string, unknown>;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type HandleGroupChatParams = {
  cfg: import("openclaw/plugin-sdk").OpenClawConfig;
  msgData: Record<string, unknown>;
  accountId: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};
