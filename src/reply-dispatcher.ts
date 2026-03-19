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
// Track active streaming card sessions by a per-message unique session key.
// Used to prevent channel.outbound.sendText from sending duplicate messages
// when streaming card mode is active.
//
// Key design:
// - sessionKey is per-message unique (e.g. "group:123:msgid-abc"), preventing
//   concurrent messages from interfering with each other's sessions.
// - entry.to stores the delivery target ("group:<id>" or username) for
//   isStreamingSessionActive() lookups.

/** Session entry with delivery target and finalize callback */
type ActiveSessionEntry = {
  /** Delivery target: "group:<id>" or username */
  to: string;
  session: StreamingCardSession | null;
  finalize: () => Promise<unknown>;
};

const activeStreamingSessions = new Map<string, ActiveSessionEntry>();

/**
 * Check if any streaming card session is active for the given delivery target.
 * Called from channel.ts to suppress duplicate sendText/sendMedia while streaming.
 */
export function isStreamingSessionActive(to: string): boolean {
  for (const entry of activeStreamingSessions.values()) {
    if (entry.to === to) return true;
  }
  return false;
}

/**
 * Register a per-message streaming session by its unique sessionKey.
 * If the same sessionKey already exists (e.g. duplicate message delivery),
 * the old session is finalized first as a safety measure.
 * With per-message unique keys this guard will rarely fire in practice.
 * @internal
 */
async function registerStreamingSession(sessionKey: string, entry: ActiveSessionEntry): Promise<void> {
  const existing = activeStreamingSessions.get(sessionKey);
  if (existing) {
    logVerbose(`[infoflow:streaming] finalizing existing session for sessionKey=${sessionKey}`);
    try {
      await existing.finalize();
    } catch (err) {
      logVerbose(`[infoflow:streaming] error finalizing existing session: ${err}`);
    }
  }
  activeStreamingSessions.set(sessionKey, entry);
}

/**
 * Mark a streaming session as completed by its unique sessionKey.
 * @internal
 */
function markStreamingSessionComplete(sessionKey: string): void {
  activeStreamingSessions.delete(sessionKey);
}

/**
 * Update the session object in the active sessions map by sessionKey.
 * @internal
 */
function updateActiveSession(sessionKey: string, session: StreamingCardSession): void {
  const entry = activeStreamingSessions.get(sessionKey);
  if (entry) {
    entry.session = session;
  }
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
  /**
   * Per-message unique key for streaming session isolation.
   * Defaults to `to` if not provided.
   * Pass a message-scoped unique value (e.g. `"${to}:${messageId}"`) to allow
   * concurrent sessions for the same target without mutual interference.
   */
  streamingSessionKey?: string;
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
    streamingSessionKey,
    statusSink,
    updateIntervalMs = 100,
  } = params;
  const core = getInfoflowRuntime();

  // Per-message unique key for activeStreamingSessions isolation.
  // Allows concurrent sessions for the same delivery target (to) without interference.
  const sessionKey = streamingSessionKey ?? to;

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

  // 重试与降级相关状态
  const MAX_RETRY_ATTEMPTS = 2;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const RETRY_DELAY_MS = 200;
  let consecutiveFailures = 0;
  let degradedToNormalSend = false;

  // Trailing update 机制：确保节流跳过后最终内容能被同步
  let trailingUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSyncedText = ""; // 上次成功同步到卡片的文本

  // 降级发送函数（流式卡片不可用时使用）
  const fallbackSend = async (text: string) => {
    if (!text.trim()) return;
    logVerbose(`[infoflow:streaming] fallback send: ${text.length} chars`);
    const chunks = core.channel.text.chunkText(text, 2048);
    for (const chunk of chunks) {
      await sendInfoflowMessage({
        cfg,
        to,
        contents: [{ type: "markdown", content: chunk }],
        accountId,
      });
    }
    statusSink?.({ lastOutboundAt: Date.now() });
  };

  // 关闭流式会话（提前声明，用于注册）
  // 返回: { finalized: boolean, hadContent: boolean, content: string }
  const closeStreaming = async (): Promise<{
    finalized: boolean;
    hadContent: boolean;
    content: string;
  }> => {
    // 清理 trailing update timer
    if (trailingUpdateTimer) {
      clearTimeout(trailingUpdateTimer);
      trailingUpdateTimer = null;
    }

    if (sessionStartPromise) {
      await sessionStartPromise;
    }
    await partialUpdateQueue;

    const hadContent = streamText.length > 0;
    const content = streamText;
    let finalized = false;

    if (session && !session.finalized) {
      const result = await finalizeStreamingSession(session, streamText);
      if (result.ok) {
        finalized = true;
      } else {
        getInfoflowSendLog().error(`[infoflow:streaming] finalize failed: ${result.error}`);
      }
    } else if (session?.finalized) {
      // 已经 finalized
      finalized = true;
    } else {
      // session 从未创建成功
      finalized = false;
    }

    session = null;
    sessionStartPromise = null;
    streamText = "";
    lastPartial = "";
    lastSyncedText = "";

    return { finalized, hadContent, content };
  };

  // Register this session by its per-message unique sessionKey.
  // With unique keys, same-target messages run independently without mutual interference.
  // The finalize guard inside registerStreamingSession handles the rare edge case of
  // duplicate message delivery with the same sessionKey.
  const sessionRegistered = registerStreamingSession(sessionKey, {
    to,
    session: null,
    finalize: closeStreaming,
  });

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

    logVerbose(`[infoflow:streaming] queueStreamingUpdate: mode=${mode}, textLength=${streamText.length}`);

    // 执行实际更新的函数（用于节流和 trailing update）
    const performUpdate = async (): Promise<boolean> => {
      if (!session || session.finalized || degradedToNormalSend) {
        return false;
      }

      logVerbose(`[infoflow:streaming] updating card with ${streamText.length} chars`);
      session.currentText = streamText;

      // 带重试的更新逻辑
      let lastError: string | undefined;
      for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logVerbose(`[infoflow:streaming] retry attempt ${attempt}/${MAX_RETRY_ATTEMPTS}`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }

        const result = await appendToStreamingSession(session, "");
        if (result.ok) {
          lastUpdateTime = Date.now();
          lastSyncedText = streamText; // 记录已同步的文本
          consecutiveFailures = 0;
          streamingContentDelivered = true; // 首次成功更新后才标记已发送
          statusSink?.({ lastOutboundAt: Date.now() });
          logVerbose(`[infoflow:streaming] card updated successfully`);
          return true;
        }
        lastError = result.error;
      }

      // 所有重试都失败
      consecutiveFailures++;
      logVerbose(`[infoflow:streaming] update failed after retries: ${lastError}, consecutiveFailures=${consecutiveFailures}`);

      // 检查是否需要降级
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logVerbose(`[infoflow:streaming] too many failures, degrading to normal send`);
        degradedToNormalSend = true;
        if (session) {
          session.finalized = true;
        }
        markStreamingSessionComplete(sessionKey);
      }
      return false;
    };

    // 安排 trailing update（确保节流跳过后最终内容能被同步）
    const scheduleTrailingUpdate = () => {
      // 清除之前的 trailing timer
      if (trailingUpdateTimer) {
        clearTimeout(trailingUpdateTimer);
      }
      // 安排在节流间隔后执行 trailing update
      trailingUpdateTimer = setTimeout(() => {
        trailingUpdateTimer = null;
        // 只有当 streamText 与 lastSyncedText 不同时才执行 trailing update
        if (streamText !== lastSyncedText && session && !session.finalized && !degradedToNormalSend) {
          logVerbose(`[infoflow:streaming] executing trailing update, textLength=${streamText.length}`);
          partialUpdateQueue = partialUpdateQueue.then(async () => {
            await performUpdate();
          });
        }
      }, updateIntervalMs + 50); // 稍微延迟一点，确保节流窗口已过
    };

    partialUpdateQueue = partialUpdateQueue.then(async () => {
      // 如果已降级，跳过流式更新（最终内容会在 deliver final 时发送）
      if (degradedToNormalSend) {
        logVerbose(`[infoflow:streaming] skipping update: already degraded to normal send`);
        return;
      }

      if (sessionStartPromise) {
        await sessionStartPromise;
      }
      if (session && !session.finalized) {
        const now = Date.now();
        // 节流：限制更新频率
        if (now - lastUpdateTime >= updateIntervalMs) {
          await performUpdate();
        } else {
          logVerbose(`[infoflow:streaming] throttled, scheduling trailing update`);
          // 被节流时，安排 trailing update 确保最终一致性
          scheduleTrailingUpdate();
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
      // Wait for session registration (handles rare duplicate-messageId edge case)
      await sessionRegistered;

      const result = await startStreamingSession({
        cfg,
        receiverId,
        receiverType,
        accountId,
      });
      if (result.ok && result.session) {
        session = result.session;
        // Update the session in the active sessions map
        updateActiveSession(sessionKey, session);
        logVerbose(`[infoflow:streaming] session created with modifyToken: ${session.modifyToken}`);
      } else {
        getInfoflowSendLog().error(
          `[infoflow:streaming] failed to create session: ${result.error}`,
        );
      }
    })();
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

      // 等待队列中的更新完成（确保降级状态已确定）
      await partialUpdateQueue;

      // 如果已降级到普通发送，使用 fallback 发送最终内容
      if (degradedToNormalSend) {
        logVerbose(`[infoflow:streaming] using fallback send due to degradation`);
        await fallbackSend(text);
        if (info?.kind === "final") {
          deliveredFinalTexts.add(text);
        }
        // 发送媒体
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
          const closeResult = await closeStreaming();
          deliveredFinalTexts.add(text);
          // 容错：如果 finalize 失败，发送降级消息
          if (!closeResult.finalized && closeResult.hadContent) {
            logVerbose(`[infoflow:streaming] finalize failed in deliver(final), sending fallback`);
            await fallbackSend(closeResult.content);
          }
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
        markStreamingSessionComplete(sessionKey);
        await fallbackSend(text);
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
    const result = await closeStreaming();
    markStreamingSessionComplete(sessionKey);

    // 容错：如果 finalize 失败但有内容，发送补救消息
    if (!result.finalized && result.hadContent) {
      logVerbose(`[infoflow:streaming] finalize failed on error, sending fallback message`);
      try {
        await fallbackSend(result.content);
      } catch (fallbackErr) {
        logVerbose(`[infoflow:streaming] fallback send also failed: ${fallbackErr}`);
      }
    }

    getInfoflowSendLog().error(
      `[infoflow:streaming] reply error to=${to}, accountId=${accountId}: ${formatInfoflowError(err)}`,
    );
  };

  const onIdle = async () => {
    const result = await closeStreaming();
    markStreamingSessionComplete(sessionKey);

    // 容错：如果 finalize 失败但有内容，发送补救消息
    if (!result.finalized && result.hadContent) {
      logVerbose(`[infoflow:streaming] finalize failed on idle, sending fallback message`);
      try {
        await fallbackSend(result.content);
      } catch (fallbackErr) {
        logVerbose(`[infoflow:streaming] fallback send also failed: ${fallbackErr}`);
      }
    }
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
      const result = await closeStreaming();
      markStreamingSessionComplete(sessionKey);

      // 容错：如果 finalize 失败但有内容，发送补救消息
      if (!result.finalized && result.hadContent) {
        logVerbose(`[infoflow:streaming] finalize failed on explicit finalize, sending fallback message`);
        try {
          await fallbackSend(result.content);
        } catch (fallbackErr) {
          logVerbose(`[infoflow:streaming] fallback send also failed: ${fallbackErr}`);
        }
      }
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
