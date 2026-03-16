import {
  createReplyPrefixOptions,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { parseMarkdownForLocalImages } from "./markdown-local-images.js";
import { prepareInfoflowImageBase64, sendInfoflowImageMessage } from "./media.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";
import {
  startStreamingSession,
  appendToStreamingSession,
  finalizeStreamingSession,
  type StreamingCardSession,
} from "./streaming-card.js";
import type {
  InfoflowAtOptions,
  InfoflowMentionIds,
  InfoflowMessageContentItem,
  InfoflowOutboundReply,
} from "./types.js";

const PREVIEW_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// Active Streaming Sessions Tracker
// ---------------------------------------------------------------------------
// Track active streaming card sessions by target address.
// Used to prevent channel.outbound.sendText from sending duplicate messages
// when streaming card mode is active.

const activeStreamingSessions = new Set<string>();

/**
 * Check if a streaming card session is active for the given target
 */
export function isStreamingSessionActive(to: string): boolean {
  return activeStreamingSessions.has(to);
}

/**
 * Mark a streaming card session as active for the given target
 * @internal
 */
function markStreamingSessionActive(to: string): void {
  activeStreamingSessions.add(to);
}

/**
 * Mark a streaming card session as completed for the given target
 * @internal
 */
function markStreamingSessionComplete(to: string): void {
  activeStreamingSessions.delete(to);
}

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

// ---------------------------------------------------------------------------
// Streaming Card Reply Dispatcher
// ---------------------------------------------------------------------------

export type CreateStreamingCardReplyDispatcherParams = CreateInfoflowReplyDispatcherParams & {
  /** 更新间隔（毫秒） */
  updateIntervalMs?: number;
  /** 最小更新字符数 */
  minCharsPerUpdate?: number;
};

/**
 * 合并流式文本
 * 处理重叠和增量更新
 */
function mergeStreamingText(previousText: string, nextText: string): string {
  if (!nextText) return previousText;
  if (!previousText || nextText === previousText) return nextText;
  if (nextText.startsWith(previousText)) return nextText;
  if (previousText.startsWith(nextText)) return previousText;
  if (nextText.includes(previousText)) return nextText;
  if (previousText.includes(nextText)) return previousText;

  // Merge partial overlaps
  const maxOverlap = Math.min(previousText.length, nextText.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousText.slice(-overlap) === nextText.slice(0, overlap)) {
      return `${previousText}${nextText.slice(overlap)}`;
    }
  }
  // Fallback: append as-is
  return `${previousText}${nextText}`;
}

/**
 * 创建流式卡片版本的回复分发器
 * 使用 onPartialReply + disableBlockStreaming
 */
export function createStreamingCardReplyDispatcher(params: CreateStreamingCardReplyDispatcherParams) {
  const {
    cfg,
    agentId,
    accountId,
    to,
    statusSink,
    updateIntervalMs = 100,
  } = params;
  const core = getInfoflowRuntime();

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "infoflow",
    accountId,
  });

  // 解析目标类型
  const isGroup = /^group:\d+$/i.test(to);
  const receiverType = isGroup ? "group" : "user";
  const receiverId = isGroup ? to.replace(/^group:/i, "") : to;

  // 流式会话状态
  let session: StreamingCardSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let lastUpdateTime = 0;
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let sessionStartPromise: Promise<void> | null = null;
  const deliveredFinalTexts = new Set<string>();
  // 标志：流式内容是否已通过卡片发送（用于防止降级重复发送）
  let streamingContentDelivered = false;

  // Mark streaming session as active immediately
  markStreamingSessionActive(to);

  // 排队流式更新
  const queueStreamingUpdate = (
    nextText: string,
    options?: { dedupeWithLastPartial?: boolean; mode?: "snapshot" | "delta" },
  ) => {
    if (!nextText) return;
    if (options?.dedupeWithLastPartial && nextText === lastPartial) return;
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";
    streamText = mode === "delta" ? `${streamText}${nextText}` : mergeStreamingText(streamText, nextText);
    // 标记已通过流式方式发送内容
    streamingContentDelivered = true;

    logVerbose(`[infoflow:streaming] queueStreamingUpdate: mode=${mode}, textLength=${streamText.length}`);

    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (sessionStartPromise) {
        await sessionStartPromise;
      }
      if (session && !session.finalized) {
        const now = Date.now();
        // 节流：限制更新频率
        if (now - lastUpdateTime >= updateIntervalMs) {
          logVerbose(`[infoflow:streaming] updating card with ${streamText.length} chars`);
          session.currentText = streamText;
          const result = await appendToStreamingSession(session, "");
          if (result.ok) {
            lastUpdateTime = now;
            statusSink?.({ lastOutboundAt: Date.now() });
            logVerbose(`[infoflow:streaming] card updated successfully`);
          } else {
            logVerbose(`[infoflow:streaming] update failed: ${result.error}`);
          }
        } else {
          logVerbose(`[infoflow:streaming] throttled, waiting ${updateIntervalMs - (now - lastUpdateTime)}ms`);
        }
      } else {
        logVerbose(`[infoflow:streaming] cannot update: session=${!!session}, finalized=${session?.finalized}`);
      }
    });
  };

  // 启动流式会话
  const startStreaming = () => {
    if (sessionStartPromise || session) return;
    sessionStartPromise = (async () => {
      const result = await startStreamingSession({
        cfg,
        receiverId,
        receiverType,
        accountId,
      });
      if (result.ok && result.session) {
        session = result.session;
        // 标记流式卡片已创建（即使还没更新内容）
        streamingContentDelivered = true;
        logVerbose(`[infoflow:streaming] session created with modifyToken: ${session.modifyToken}`);
      } else {
        getInfoflowSendLog().error(
          `[infoflow:streaming] failed to create session: ${result.error}`,
        );
      }
    })();
  };

  // 关闭流式会话
  const closeStreaming = async () => {
    if (sessionStartPromise) {
      await sessionStartPromise;
    }
    await partialUpdateQueue;
    if (session && !session.finalized) {
      const result = await finalizeStreamingSession(session, streamText);
      if (!result.ok) {
        getInfoflowSendLog().error(`[infoflow:streaming] finalize failed: ${result.error}`);
      }
    }
    session = null;
    sessionStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  // deliver 函数 - 判断 info.kind
  // 关键：当 disableBlockStreaming: true 时，只会收到 "final" 类型
  // 流式更新通过 onPartialReply 回调处理
  const deliver = async (payload: ReplyPayload, info?: { kind: string }) => {
    const text = payload.text ?? "";
    const hasText = Boolean(text.trim());
    const mediaList =
      payload.mediaUrls && payload.mediaUrls.length > 0
        ? payload.mediaUrls
        : payload.mediaUrl
          ? [payload.mediaUrl]
          : [];
    const hasMedia = mediaList.length > 0;

    const skipTextForDuplicateFinal = info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
    const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

    logVerbose(`[infoflow:streaming] deliver called: kind=${info?.kind}, hasText=${hasText}, hasMedia=${hasMedia}, sessionExists=${!!session}`);

    if (!shouldDeliverText && !hasMedia) {
      return;
    }

    if (shouldDeliverText) {
      // 等待流式会话创建完成（如果正在创建）
      if (sessionStartPromise) {
        await sessionStartPromise;
      }

      // 如果流式会话已创建且未结束，通过流式卡片处理
      if (session && !session.finalized) {
        if (info?.kind === "block") {
          // block 类型：合并到流式文本（作为 onPartialReply 的备选）
          queueStreamingUpdate(text, { mode: "delta" });
          return;
        }

        if (info?.kind === "final") {
          // final 类型：合并最终文本并关闭流式
          streamText = mergeStreamingText(streamText, text);
          await closeStreaming();
          deliveredFinalTexts.add(text);
          // 媒体单独发送
          if (hasMedia) {
            for (const mediaUrl of mediaList) {
              await sendInfoflowMessage({
                cfg,
                to,
                contents: [{ type: "link", content: mediaUrl }],
                accountId,
              });
            }
          }
          return;
        }

        // 其他类型（如 tool）：也通过流式卡片更新
        queueStreamingUpdate(text, { mode: "snapshot" });
        return;
      }

      // 降级到普通发送（流式卡片不可用时）
      // 但如果内容已通过流式卡片发送，跳过降级发送以避免重复
      if (streamingContentDelivered) {
        logVerbose(`[infoflow:streaming] skipping fallback send: content already delivered via streaming card`);
        if (info?.kind === "final") {
          deliveredFinalTexts.add(text);
        }
        // 继续发送媒体（媒体不通过流式卡片）
      } else {
        logVerbose(`[infoflow:streaming] fallback to normal send: session=${!!session}, finalized=${session?.finalized}`);
        markStreamingSessionComplete(to);
        const chunks = core.channel.text.chunkText(text, 2048);
        for (const chunk of chunks) {
          await sendInfoflowMessage({
            cfg,
            to,
            contents: [{ type: "markdown", content: chunk }],
            accountId,
          });
        }
        if (info?.kind === "final") {
          deliveredFinalTexts.add(text);
        }
      }
    }

    // 发送媒体（不通过流式卡片）
    if (hasMedia && !shouldDeliverText) {
      for (const mediaUrl of mediaList) {
        await sendInfoflowMessage({
          cfg,
          to,
          contents: [{ type: "link", content: mediaUrl }],
          accountId,
        });
      }
    }
  };

  const onError = async (err: unknown) => {
    await closeStreaming();
    markStreamingSessionComplete(to);
    getInfoflowSendLog().error(
      `[infoflow:streaming] reply error to=${to}, accountId=${accountId}: ${formatInfoflowError(err)}`,
    );
  };

  const onIdle = async () => {
    await closeStreaming();
    markStreamingSessionComplete(to);
  };

  return {
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError,
      onIdle,
    },
    replyOptions: {
      onModelSelected,
      // 关键：禁用块流式，通过 onPartialReply 接收流式内容
      disableBlockStreaming: true,
      onPartialReply: (payload: ReplyPayload) => {
        if (!payload.text) return;
        logVerbose(`[infoflow:streaming] onPartialReply: textLength=${payload.text.length}`);
        // 启动流式会话（如果还没启动）
        startStreaming();
        // 更新流式内容
        queueStreamingUpdate(payload.text, {
          dedupeWithLastPartial: true,
          mode: "snapshot",
        });
      },
    },
    // 暴露 finalize 供外部调用
    finalize: async () => {
      await closeStreaming();
      markStreamingSessionComplete(to);
    },
  };
}

/**
 * 根据配置选择合适的 reply dispatcher（简化版：只有 on/off）
 */
export function createInfoflowReplyDispatcherAuto(params: CreateInfoflowReplyDispatcherParams) {
  const { cfg, accountId } = params;

  // 获取流式配置
  const account = resolveInfoflowAccount({ cfg, accountId });
  const streamingEnabled = account.config.streaming === true;

  logVerbose(`[infoflow] streaming enabled: ${streamingEnabled}`);

  if (streamingEnabled) {
    // 使用流式卡片
    return createStreamingCardReplyDispatcher({
      ...params,
      updateIntervalMs: 100,
      minCharsPerUpdate: 10,
    });
  }

  // 默认使用普通 dispatcher
  return createInfoflowReplyDispatcher(params);
}
