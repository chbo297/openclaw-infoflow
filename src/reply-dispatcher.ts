import {
  createReplyPrefixOptions,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { parseMarkdownForLocalImages } from "./markdown-local-images.js";
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
  /** Optional local filesystem roots for resolving local image paths in text */
  mediaLocalRoots?: readonly string[];
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
    mediaLocalRoots,
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

      // Chunk text to 2048 chars max (Infoflow limit)
      const chunks = core.channel.text.chunkText(messageText, 2048);
      let isFirstChunk = true;
      const textPromises: Promise<{ ok?: boolean; error?: string }>[] = [];

      for (const chunk of chunks) {
        const segments = parseMarkdownForLocalImages(chunk);

        for (const segment of segments) {
          const chunkReplyTo = !replyApplied ? replyTo : undefined;

          if (segment.type === "text") {
            const contents: InfoflowMessageContentItem[] = [];
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
            const trimmed = segment.content.trim();
            if (contents.length > 0 || trimmed) {
              contents.push({ type: "markdown", content: segment.content });
              textPromises.push(
                sendInfoflowMessage({
                  cfg,
                  to,
                  contents,
                  accountId,
                  replyTo: chunkReplyTo,
                }),
              );
              if (chunkReplyTo) replyApplied = true;
            }
            isFirstChunk = false;
            continue;
          }

          // segment.type === "image"
          if (isFirstChunk && isGroup && (hasAtAll || hasAtUsers || hasAtAgents)) {
            const atContents: InfoflowMessageContentItem[] = [];
            if (hasAtAll) atContents.push({ type: "at", content: "all" });
            else if (hasAtUsers) atContents.push({ type: "at", content: allAtUserIds.join(",") });
            if (hasAtAgents)
              atContents.push({ type: "at-agent", content: resolvedAgentIds.join(",") });
            atContents.push({ type: "markdown", content: "" });
            textPromises.push(
              sendInfoflowMessage({
                cfg,
                to,
                contents: atContents,
                accountId,
                replyTo: chunkReplyTo,
              }),
            );
            if (chunkReplyTo) replyApplied = true;
          }
          isFirstChunk = false;

          try {
            const prepared = await prepareInfoflowImageBase64({
              mediaUrl: segment.content,
              mediaLocalRoots: mediaLocalRoots ?? undefined,
            });
            if (prepared.isImage) {
              const segmentReplyTo = !replyApplied ? replyTo : undefined;
              textPromises.push(
                sendInfoflowImageMessage({
                  cfg,
                  to,
                  base64Image: prepared.base64,
                  accountId,
                  replyTo: segmentReplyTo,
                }).then((r) => {
                  if (r.ok) return r;
                  logVerbose(
                    `[infoflow] native image send failed: ${r.error}, falling back to link`,
                  );
                  return sendInfoflowMessage({
                    cfg,
                    to,
                    contents: [{ type: "link", content: segment.content }],
                    accountId,
                    replyTo: segmentReplyTo,
                  });
                }),
              );
              if (!replyApplied) replyApplied = true;
            } else {
              textPromises.push(
                sendInfoflowMessage({
                  cfg,
                  to,
                  contents: [{ type: "link", content: segment.content }],
                  accountId,
                  replyTo: !replyApplied ? replyTo : undefined,
                }),
              );
              if (!replyApplied) replyApplied = true;
            }
          } catch (err) {
            logVerbose(
              `[infoflow] image prep failed in text segment, falling back to link: ${err}`,
            );
            textPromises.push(
              sendInfoflowMessage({
                cfg,
                to,
                contents: [{ type: "link", content: segment.content }],
                accountId,
                replyTo: !replyApplied ? replyTo : undefined,
              }),
            );
            if (!replyApplied) replyApplied = true;
          }
        }
      }

      if (textPromises.length > 0) {
        const results = await Promise.all(textPromises);
        for (const result of results) {
          if (result?.ok) {
            statusSink?.({ lastOutboundAt: Date.now() });
          } else if (result?.error) {
            getInfoflowSendLog().error(
              `[infoflow] reply failed to=${to}, accountId=${accountId}: ${result.error}`,
            );
          }
        }
      }
    }

    // --- Media handling: send each media item as native image or fallback link (b-mode: collect then await) ---
    const mediaPromises: Promise<{ ok?: boolean; error?: string }>[] = [];
    for (const mediaUrl of mediaList) {
      const mediaReplyTo = !replyApplied ? replyTo : undefined;
      try {
        const prepared = await prepareInfoflowImageBase64({ mediaUrl });
        if (prepared.isImage) {
          mediaPromises.push(
            sendInfoflowImageMessage({
              cfg,
              to,
              base64Image: prepared.base64,
              accountId,
              replyTo: mediaReplyTo,
            }).then((r) => {
              if (r.ok) return r;
              logVerbose(`[infoflow] native image send failed: ${r.error}, falling back to link`);
              return sendInfoflowMessage({
                cfg,
                to,
                contents: [{ type: "link", content: mediaUrl }],
                accountId,
                replyTo: mediaReplyTo,
              });
            }),
          );
          if (mediaReplyTo) replyApplied = true;
        } else {
          mediaPromises.push(
            sendInfoflowMessage({
              cfg,
              to,
              contents: [{ type: "link", content: mediaUrl }],
              accountId,
              replyTo: mediaReplyTo,
            }),
          );
          if (mediaReplyTo) replyApplied = true;
        }
      } catch (err) {
        logVerbose(`[infoflow] image prep failed, falling back to link: ${err}`);
        mediaPromises.push(
          sendInfoflowMessage({
            cfg,
            to,
            contents: [{ type: "link", content: mediaUrl }],
            accountId,
            replyTo: mediaReplyTo,
          }),
        );
        if (mediaReplyTo) replyApplied = true;
      }
    }
    if (mediaPromises.length > 0) {
      const results = await Promise.all(mediaPromises);
      for (const result of results) {
        if (result?.ok) statusSink?.({ lastOutboundAt: Date.now() });
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
