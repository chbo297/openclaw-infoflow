import {
  createReplyPrefixOptions,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";
import type { InfoflowAtOptions, InfoflowMentionIds, InfoflowMessageContentItem } from "./types.js";

export type CreateInfoflowReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  /** Target: "group:<id>" for group chat, username for private chat */
  to: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** AT options for @mentioning members in group messages */
  atOptions?: InfoflowAtOptions;
  /** Mention IDs from inbound message for resolving @id in LLM output */
  mentionIds?: InfoflowMentionIds;
};

/**
 * Builds dispatcherOptions and replyOptions for dispatchReplyWithBufferedBlockDispatcher.
 * Encapsulates prefix options, chunked deliver (send via Infoflow API + statusSink), and onError.
 */
export function createInfoflowReplyDispatcher(params: CreateInfoflowReplyDispatcherParams) {
  const { cfg, agentId, accountId, to, statusSink, atOptions, mentionIds } = params;
  const core = getInfoflowRuntime();

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "infoflow",
    accountId,
  });

  // Check if target is a group (format: group:<id>)
  const isGroup = /^group:\d+$/i.test(to);

  // Build id→type map for resolving @id in LLM output (distinguishes user vs agent)
  const mentionIdMap = new Map<string, "user" | "agent">();
  if (mentionIds) {
    for (const id of mentionIds.userIds) {
      mentionIdMap.set(id.toLowerCase(), "user");
    }
    for (const id of mentionIds.agentIds) {
      mentionIdMap.set(String(id).toLowerCase(), "agent");
    }
  }

  const deliver = async (payload: ReplyPayload) => {
    const text = payload.text ?? "";
    logVerbose(`[infoflow] deliver called: to=${to}, text=${text}`);
    if (!text.trim()) {
      return;
    }

    // Resolve @id patterns in LLM output text to user/agent IDs
    const resolvedUserIds: string[] = [];
    const resolvedAgentIds: number[] = [];
    if (isGroup && mentionIdMap.size > 0) {
      const mentionPattern = /@([\w.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = mentionPattern.exec(text)) !== null) {
        const id = match[1];
        const type = mentionIdMap.get(id.toLowerCase());
        if (type === "user" && !resolvedUserIds.includes(id)) {
          resolvedUserIds.push(id);
        } else if (type === "agent") {
          const numId = Number(id);
          if (Number.isFinite(numId) && !resolvedAgentIds.includes(numId)) {
            resolvedAgentIds.push(numId);
          }
        }
      }
    }

    // Merge atOptions user IDs (sender echo-back) with LLM-resolved user IDs
    const atOptionIds = atOptions?.atAll ? [] : (atOptions?.atUserIds ?? []);
    const allAtUserIds = [...atOptionIds];
    for (const id of resolvedUserIds) {
      if (!allAtUserIds.includes(id)) {
        allAtUserIds.push(id);
      }
    }
    const hasAtAll = atOptions?.atAll === true;
    const hasAtUsers = allAtUserIds.length > 0;
    const hasAtAgents = resolvedAgentIds.length > 0;

    // Prepend AT mentions to the text if needed (group messages only)
    // Only prepend for atOptions IDs; LLM text already contains @id for resolved mentions
    let messageText = text;
    if (isGroup && atOptions) {
      let atPrefix = "";
      if (hasAtAll) {
        atPrefix = "@all ";
      } else if (atOptions.atUserIds?.length) {
        atPrefix = atOptions.atUserIds.map((id) => `@${id}`).join(" ") + " ";
      }
      messageText = atPrefix + text;
    }

    // Chunk text to 4000 chars max (Infoflow limit)
    const chunks = core.channel.text.chunkText(messageText, 4000);
    // Only include @mentions in the first chunk (avoid duplicate @s)
    let isFirstChunk = true;

    for (const chunk of chunks) {
      const contents: InfoflowMessageContentItem[] = [];

      // Add AT content nodes for group messages (first chunk only)
      if (isFirstChunk && isGroup) {
        if (hasAtAll) {
          contents.push({ type: "at", content: "all" });
        } else if (hasAtUsers) {
          contents.push({ type: "at", content: allAtUserIds.join(",") });
        }
        if (hasAtAgents) {
          contents.push({ type: "at-agent", content: resolvedAgentIds.join(",") });
        }
      }
      isFirstChunk = false;

      // Add markdown content
      contents.push({ type: "markdown", content: chunk });

      const result = await sendInfoflowMessage({ cfg, to, contents, accountId });

      if (result.ok) {
        statusSink?.({ lastOutboundAt: Date.now() });
      } else if (result.error) {
        getInfoflowSendLog().error(
          `[infoflow] reply failed to=${to}, accountId=${accountId}: ${result.error}`,
        );
      }
    }
  };

  const onError = (err: unknown) => {
    getInfoflowSendLog().error(
      `[infoflow] reply error to=${to}, accountId=${accountId}: ${formatInfoflowError(err)}`,
    );
  };

  return {
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError,
    },
    replyOptions: {
      onModelSelected,
    },
  };
}
