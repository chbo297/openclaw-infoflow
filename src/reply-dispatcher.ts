import {
  createReplyPrefixOptions,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { prepareInfoflowImageBase64, sendInfoflowImageMessage } from "./media.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";
import type {
  InfoflowAtOptions,
  InfoflowMentionIds,
  InfoflowMessageContentItem,
  InfoflowOutboundReply,
} from "./types.js";

const PREVIEW_MAX_LENGTH = 100;

function truncatePreview(text?: string): string {
  if (!text) return "";
  if (text.length <= PREVIEW_MAX_LENGTH) return text;
  return text.slice(0, PREVIEW_MAX_LENGTH) + "...";
}

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
  /** Inbound message ID for outbound reply-to (group only) */
  replyToMessageId?: string;
  /** Preview text of the inbound message for reply context */
  replyToPreview?: string;
};

/**
 * Builds dispatcherOptions and replyOptions for dispatchReplyWithBufferedBlockDispatcher.
 * Encapsulates prefix options, chunked deliver (send via Infoflow API + statusSink), and onError.
 */
export function createInfoflowReplyDispatcher(params: CreateInfoflowReplyDispatcherParams) {
  const {
    cfg,
    agentId,
    accountId,
    to,
    statusSink,
    atOptions,
    mentionIds,
    replyToMessageId,
    replyToPreview,
  } = params;
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

  // Build replyTo context (only used for the first outbound message)
  const replyTo: InfoflowOutboundReply | undefined =
    isGroup && replyToMessageId
      ? { messageid: replyToMessageId, preview: truncatePreview(replyToPreview) }
      : undefined;
  let replyApplied = false;

  const deliver = async (payload: ReplyPayload) => {
    const text = payload.text ?? "";
    logVerbose(`[infoflow] deliver called: to=${to}, text=${text}`);

    // Normalize media URL list (same pattern as Feishu reply-dispatcher)
    const mediaList =
      payload.mediaUrls && payload.mediaUrls.length > 0
        ? payload.mediaUrls
        : payload.mediaUrl
          ? [payload.mediaUrl]
          : [];

    if (!text.trim() && mediaList.length === 0) {
      return;
    }

    // --- Text handling (existing logic) ---
    if (text.trim()) {
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

        // Only include replyTo on the first outbound message
        const chunkReplyTo = !replyApplied ? replyTo : undefined;
        const result = await sendInfoflowMessage({
          cfg,
          to,
          contents,
          accountId,
          replyTo: chunkReplyTo,
        });
        if (chunkReplyTo) replyApplied = true;

        if (result.ok) {
          statusSink?.({ lastOutboundAt: Date.now() });
        } else if (result.error) {
          getInfoflowSendLog().error(
            `[infoflow] reply failed to=${to}, accountId=${accountId}: ${result.error}`,
          );
        }
      }
    }

    // --- Media handling: send each media item as native image or fallback link ---
    for (const mediaUrl of mediaList) {
      const mediaReplyTo = !replyApplied ? replyTo : undefined;
      try {
        const prepared = await prepareInfoflowImageBase64({ mediaUrl });
        if (prepared.isImage) {
          const result = await sendInfoflowImageMessage({
            cfg,
            to,
            base64Image: prepared.base64,
            accountId,
            replyTo: mediaReplyTo,
          });
          if (result.ok) {
            if (mediaReplyTo) replyApplied = true;
            statusSink?.({ lastOutboundAt: Date.now() });
            continue;
          }
          logVerbose(`[infoflow] native image send failed: ${result.error}, falling back to link`);
        }
      } catch (err) {
        logVerbose(`[infoflow] image prep failed, falling back to link: ${err}`);
      }
      // Fallback: send as link
      await sendInfoflowMessage({
        cfg,
        to,
        contents: [{ type: "link", content: mediaUrl }],
        accountId,
        replyTo: mediaReplyTo,
      });
      if (mediaReplyTo) replyApplied = true;
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
