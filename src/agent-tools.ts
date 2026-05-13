/**
 * LLM-callable tools exposed by the Infoflow channel plugin.
 *
 * Currently exposes: `infoflow_list_sent_messages` — lets the LLM look up
 * bot-sent messages by target / time window / content substring when the
 * push-injected recent list (in bot.ts) isn't enough (e.g., older messages,
 * search-by-content).
 */

import type { ChannelAgentTool, OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { Type, type Static } from "typebox";
import { resolveDefaultInfoflowAccountId } from "./accounts.js";
import { logVerbose } from "./logging.js";
import { querySentMessages } from "./sent-message-store.js";

const listSentMessagesSchema = Type.Object({
  target: Type.String({
    description:
      "Chat target to query. Format: 'group:<groupId>' for groups or '<username>' for private chats. " +
      "MUST be the current chat target — do not query other chats.",
  }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      default: 20,
      description: "Maximum number of messages to return, newest first.",
    }),
  ),
  withinHours: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 168,
      description:
        "Only include messages sent within the last N hours (1-168, i.e. up to 7 days, which matches the store's retention). Omit for no time filter.",
    }),
  ),
  containsText: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring filter against the message digest (first ~100 chars of body). Use this to find a message by content, e.g. containsText='会议改到3点'.",
    }),
  ),
  accountId: Type.Optional(
    Type.String({
      description:
        "Account id to query against (only needed when multiple Infoflow accounts are configured). Defaults to the configured default account.",
    }),
  ),
});

type ListSentMessagesParams = Static<typeof listSentMessagesSchema>;

const TOOL_DESCRIPTION = [
  "List messages the bot previously sent to a given Infoflow chat, with optional time-window and content-substring filters.",
  "Use this BEFORE action='delete' when:",
  "  (a) the message you need to recall is older than the recent list already injected into the message body, or",
  "  (b) you need to find a bot-sent message by its content (e.g. 'the joke about programmers', '会议通知').",
  "Returns: target, count, and an array of { messageId, sentAt, ageMinutes, preview }.",
  "Feed the chosen messageId back into action='delete' to recall it.",
].join("\n");

export function createListSentMessagesTool(deps: {
  /** Lazy cfg accessor; the tool resolves the latest config on each invocation. */
  getConfig: () => OpenClawConfig;
}): ChannelAgentTool {
  return {
    name: "infoflow_list_sent_messages",
    label: "infoflow_list_sent_messages",
    description: TOOL_DESCRIPTION,
    parameters: listSentMessagesSchema,
    execute: async (_toolCallId, rawParams) => {
      const p = (rawParams ?? {}) as ListSentMessagesParams;
      if (typeof p.target !== "string" || !p.target.trim()) {
        throw new Error("infoflow_list_sent_messages: 'target' is required.");
      }
      const target = p.target.trim();
      const limit = Math.min(Math.max(p.count ?? 20, 1), 50);
      const hasContains = typeof p.containsText === "string" && p.containsText.trim().length > 0;
      const needle = hasContains ? (p.containsText as string).trim().toLowerCase() : undefined;

      let accountId = p.accountId?.trim();
      if (!accountId) {
        try {
          accountId = resolveDefaultInfoflowAccountId(deps.getConfig());
        } catch {
          accountId = undefined;
        }
      }
      if (!accountId) {
        throw new Error(
          "infoflow_list_sent_messages: cannot resolve account id. Pass accountId explicitly or configure a default account.",
        );
      }

      // Over-fetch when filtering by content so the post-filter slice still has up to `limit` rows.
      const fetchCount = needle ? Math.max(limit * 4, 50) : limit;
      let records;
      try {
        records = querySentMessages(accountId, { target, count: fetchCount });
      } catch (err) {
        throw new Error(
          `infoflow_list_sent_messages: store query failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }

      if (p.withinHours) {
        const cutoff = Date.now() - p.withinHours * 60 * 60 * 1000;
        records = records.filter((r) => r.sentAt >= cutoff);
      }
      if (needle) {
        records = records.filter((r) => (r.digest ?? "").toLowerCase().includes(needle));
      }
      const sliced = records.slice(0, limit);

      logVerbose(
        `[infoflow:tool:list_sent_messages] target=${target} accountId=${accountId} count=${sliced.length} (limit=${limit}, withinHours=${p.withinHours ?? "none"}, containsText=${hasContains ? "yes" : "no"})`,
      );

      return jsonResult({
        target,
        count: sliced.length,
        messages: sliced.map((r) => ({
          messageId: r.messageid,
          sentAt: new Date(r.sentAt).toISOString(),
          ageMinutes: Math.max(0, Math.round((Date.now() - r.sentAt) / 60000)),
          preview: r.digest || "",
        })),
      });
    },
  };
}
