/**
 * Infoflow channel message actions adapter.
 * Intercepts the "send" action from the message tool to support
 * @all and @user mentions in group messages.
 */

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { resolveInfoflowAccount } from "./accounts.js";
import { looksLikeRecallLatest } from "./recall-intent.js";
import { lookupInboundContext } from "./inbound-context.js";
import { logVerbose } from "./logging.js";
import { prepareInfoflowImageBase64, sendInfoflowImageMessage } from "./media.js";
import {
  sendInfoflowMessage,
  recallInfoflowGroupMessage,
  recallInfoflowPrivateMessage,
} from "./send.js";
import {
  findSentMessage,
  querySentMessages,
  removeRecalledMessages,
  type SentMessageRecord,
} from "./sent-message-store.js";
import { normalizeInfoflowTarget } from "./targets.js";
import type { InfoflowMessageContentItem, InfoflowOutboundReply } from "./types.js";

// Recall result hint constants — reused across single/batch, group/private recall paths
const RECALL_OK_HINT = "Recall succeeded. output only NO_REPLY with no other text.";
const RECALL_FAIL_HINT = "Recall failed. Send a brief reply stating only the failure reason.";
const RECALL_PARTIAL_HINT =
  "Some recalls failed. Send a brief reply stating only the failure reason(s).";

/**
 * Resolve the inbound replyToMessageId from the action ctx + inbound-context map.
 * Returns the bot-sent messageId the user is quote-replying to (if any), so we
 * can recover when the LLM accidentally passes the inbound user-message id as
 * the delete target.
 */
function resolveInboundReplyToMessageId(params: {
  accountId: string;
  target: string;
  currentMessageId: string | number | undefined;
}): string | undefined {
  const currentMessageId =
    params.currentMessageId != null ? String(params.currentMessageId) : undefined;
  if (!currentMessageId) return undefined;
  const ctx = lookupInboundContext(currentMessageId);
  if (!ctx) return undefined;
  // Scope match: same account + target (avoid using a stale context from another chat).
  if (ctx.accountId !== params.accountId) return undefined;
  if (ctx.target !== params.target) return undefined;
}

/**
 * Aggressive guard: when LLM passes messageId === inbound currentMessageId (a known
 * confusion pattern), auto-correct based on context instead of failing.
 *
 * Priorities:
 * 1) Use replyToMessageId — user quote-replied to a bot message (highest confidence).
 * 2) Drop to count=1 mode — when no replyTo AND text indicates "recall latest one".
 * 3) Defer to existing fallback chain — ambiguous intent (e.g., "recall the one about X").
 *
 * Returns the corrected messageId (or undefined to signal count=1 mode).
 */
function applyAggressiveGuardForInboundMessageId(params: {
  messageId: string;
  currentMessageId: string | number | undefined;
  accountId: string;
  target: string;
}): string | undefined {
  const inboundMsgId =
    params.currentMessageId != null ? String(params.currentMessageId) : undefined;

  // Guard only triggers when LLM passes the inbound message id as delete target
  if (!inboundMsgId || params.messageId !== inboundMsgId) {
    return params.messageId;
  }

  const ctxRec = lookupInboundContext(inboundMsgId);
  const scopeOk =
    ctxRec && ctxRec.accountId === params.accountId && ctxRec.target === params.target;

  if (!scopeOk) {
    // No inbound context to guide correction — defer to existing fallback chain
    return params.messageId;
  }

  // Priority 1: replyToMessageId (user quote-replied to a bot message)
  const replyToId = ctxRec.replyToMessageId;
  if (replyToId && findSentMessage(params.accountId, replyToId)) {
    logVerbose(
      `[infoflow:delete] aggressive: messageId==inboundMsgId(${params.messageId}); using replyTo=${replyToId}`,
    );
    return replyToId;
  }

  // Priority 2: text indicates "recall latest one" — safe to auto-correct to count=1
  if (looksLikeRecallLatest(ctxRec.inboundBody ?? "")) {
    logVerbose(
      `[infoflow:delete] aggressive: messageId==inboundMsgId(${params.messageId}); recall-latest intent → drop to count=1`,
    );
    return undefined; // undefined → count=1 mode
  }

  // Priority 3: ambiguous intent — defer to existing fallback chain
  logVerbose(
    `[infoflow:delete] aggressive: messageId==inboundMsgId(${params.messageId}); ambiguous intent → defer to candidate-error path`,
  );
  return params.messageId;
}



/** Format up to N recent sent messages for an error-path hint to the LLM. */
function formatRecentCandidatesForError(records: SentMessageRecord[], limit = 5): string {
  if (!records || !Array.isArray(records) || records.length === 0) return "";
  const lines = records.slice(0, limit).map((r) => {
    const previewText = r.digest || "(no preview)";
    return `messageId=${r.messageid} preview="${previewText}"`;
  });
  return lines.join("; ");
}

/** Safe candidate lookup that never throws (errors → empty string). */
function safeRecentCandidates(accountId: string, target: string): string {
  try {
    const records = querySentMessages(accountId, { target, count: 5 });
    return formatRecentCandidatesForError(records);
  } catch {
    return "";
  }
}

export const infoflowMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({
    actions: ["send", "delete"] satisfies readonly ChannelMessageActionName[],
  }),

  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),

  handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
    // -----------------------------------------------------------------------
    // delete (群消息撤回) — Mode A: by messageId, Mode B: by count
    // -----------------------------------------------------------------------
    if (action === "delete") {
      const rawTo = readStringParam(params, "to", { required: true });
      if (!rawTo) {
        throw new Error("delete requires a target (to).");
      }
      const to = normalizeInfoflowTarget(rawTo) ?? rawTo;
      const target = to.replace(/^infoflow:/i, "");

      const account = resolveInfoflowAccount({ cfg, accountId: accountId ?? undefined });
      if (!account.config.appKey || !account.config.appSecret) {
        throw new Error("Infoflow appKey/appSecret not configured.");
      }

      let messageId = readStringParam(params, "messageId");
      // Default to count=1 (recall latest message) when neither messageId nor count is provided
      const countStr = readStringParam(params, "count") ?? (messageId ? undefined : "1");

      const groupMatch = target.match(/^group:(\d+)/i);

      if (groupMatch) {
        // -----------------------------------------------------------------
        // 群消息撤回
        // -----------------------------------------------------------------
        const groupId = Number(groupMatch[1]);
        const targetForStore = `group:${groupId}`;
        // Apply aggressive guard when messageId equals inbound currentMessageId (LLM confusion pattern)
        if (messageId) {
          messageId = applyAggressiveGuardForInboundMessageId({
            messageId,
            currentMessageId: toolContext?.currentMessageId,
            accountId: account.accountId,
            target: targetForStore,
          });
        }

        // Mode A: single message recall by messageId
        if (messageId) {
          // Resolve msgseqid (group recall requires it). If the LLM-passed messageId
          // is unknown to the store, fall back to the inbound replyToMessageId — the
          // common failure mode is the LLM passing the inbound user-message id as
          // the delete target instead of the bot-message id it's quote-replying to.
          let effectiveMessageId = messageId;
          let msgseqid = readStringParam(params, "msgseqid") ?? "";
          let stored = findSentMessage(account.accountId, effectiveMessageId);

          if (!stored && !msgseqid) {
            const fallbackId = resolveInboundReplyToMessageId({
              accountId: account.accountId,
              target: targetForStore,
              currentMessageId: toolContext?.currentMessageId,
            });
            if (fallbackId && fallbackId !== effectiveMessageId) {
              const fallbackStored = findSentMessage(account.accountId, fallbackId);
              if (fallbackStored) {
                logVerbose(
                  `[infoflow:delete] LLM passed unknown messageId=${effectiveMessageId}, falling back to replyToMessageId=${fallbackId}`,
                );
                effectiveMessageId = fallbackId;
                stored = fallbackStored;
              }
            }
          }

          if (!msgseqid && stored?.msgseqid) {
            msgseqid = stored.msgseqid;
          }

          if (!msgseqid) {
            const candidates = safeRecentCandidates(account.accountId, `group:${groupId}`);
            logVerbose(
              `[infoflow:delete] unknown messageId=${effectiveMessageId}, no fallback available, returning candidates to LLM`,
            );
            throw new Error(
              `delete: messageId=${effectiveMessageId} is not a known bot-sent message in this chat (msgseqid not found in store). ` +
                `It looks like you may have passed the inbound (user) message id instead of the bot's. ` +
                (candidates
                  ? `Recent bot-sent messages here: ${candidates}. Pick the right messageId and retry.`
                  : `No recent bot-sent messages on file for this chat. Aborting to avoid wrong recall.`),
            );
          }

          const result = await recallInfoflowGroupMessage({
            account,
            groupId,
            messageid: effectiveMessageId,
            msgseqid,
          });

          if (result.ok) {
            try {
              removeRecalledMessages(account.accountId, [effectiveMessageId]);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: result.ok,
            channel: "infoflow",
            to,
            messageId: effectiveMessageId,
            ...(result.error ? { error: result.error } : {}),
            _hint: result.ok ? RECALL_OK_HINT : RECALL_FAIL_HINT,
          });
        }

        // Mode B: batch recall by count
        if (countStr) {
          const count = Number(countStr);
          if (!Number.isFinite(count) || count < 1) {
            throw new Error("count must be a positive integer.");
          }

          const records = querySentMessages(account.accountId, {
            target: targetForStore,
            count,
          });
          // Filter to records that have msgseqid (required for group recall)
          const recallable = records.filter((r) => r.msgseqid);

          if (recallable.length === 0) {
            return jsonResult({
              ok: true,
              channel: "infoflow",
              to,
              recalled: 0,
              message: "No recallable messages found in store.",
              _hint: "No messages found to recall. Briefly inform the user.",
            });
          }

          let succeeded = 0;
          let failed = 0;
          const recalledIds: string[] = [];
          const details: Array<{
            messageid: string;
            digest: string;
            ok: boolean;
            error?: string;
          }> = [];

          for (const record of recallable) {
            const result = await recallInfoflowGroupMessage({
              account,
              groupId,
              messageid: record.messageid,
              msgseqid: record.msgseqid,
            });

            if (result.ok) {
              succeeded++;
              recalledIds.push(record.messageid);
              details.push({ messageid: record.messageid, digest: record.digest, ok: true });
            } else {
              failed++;
              details.push({
                messageid: record.messageid,
                digest: record.digest,
                ok: false,
                error: result.error,
              });
            }
          }

          if (recalledIds.length > 0) {
            try {
              removeRecalledMessages(account.accountId, recalledIds);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: failed === 0,
            channel: "infoflow",
            to,
            recalled: succeeded,
            failed,
            total: recallable.length,
            details,
            _hint: failed === 0 ? RECALL_OK_HINT : RECALL_PARTIAL_HINT,
          });
        }
      } else {
        // -----------------------------------------------------------------
        // 私聊消息撤回
        // -----------------------------------------------------------------
        const appAgentId = account.config.appAgentId;
        if (!appAgentId) {
          throw new Error(
            "Infoflow private message recall requires appAgentId configuration. " +
              "Set channels.infoflow.appAgentId to your application ID (如流企业后台的应用ID).",
          );
        }

        // Apply aggressive guard when messageId equals inbound currentMessageId (LLM confusion pattern)
        if (messageId) {
          messageId = applyAggressiveGuardForInboundMessageId({
            messageId,
            currentMessageId: toolContext?.currentMessageId,
            accountId: account.accountId,
            target,
          });
        }

        // Mode A: single message recall by messageId (msgkey)
        if (messageId) {
          // Attempt the inbound-context fallback when the LLM-passed messageId is
          // unknown to the store. If we can swap it for a verified bot-message id
          // from the inbound replyTo, do so. Otherwise PRESERVE the original
          // permissive behavior (pass the LLM id straight to the API and let
          // Infoflow's backend judge) — the store may legitimately not contain
          // every recallable DM message (e.g., after the 7-day retention sweep
          // or for messages sent before this plugin started recording).
          let effectiveMessageId = messageId;
          const stored = findSentMessage(account.accountId, effectiveMessageId);

          if (!stored) {
            const fallbackId = resolveInboundReplyToMessageId({
              accountId: account.accountId,
              target,
              currentMessageId: toolContext?.currentMessageId,
            });
            if (fallbackId && fallbackId !== effectiveMessageId) {
              const fallbackStored = findSentMessage(account.accountId, fallbackId);
              if (fallbackStored) {
                logVerbose(
                  `[infoflow:delete] LLM passed unknown messageId=${effectiveMessageId}, falling back to replyToMessageId=${fallbackId}`,
                );
                effectiveMessageId = fallbackId;
              }
            }
          }

          const result = await recallInfoflowPrivateMessage({
            account,
            msgkey: effectiveMessageId,
            appAgentId,
          });

          if (result.ok) {
            try {
              removeRecalledMessages(account.accountId, [effectiveMessageId]);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: result.ok,
            channel: "infoflow",
            to,
            messageId: effectiveMessageId,
            ...(result.error ? { error: result.error } : {}),
            _hint: result.ok ? RECALL_OK_HINT : RECALL_FAIL_HINT,
          });
        }

        // Mode B: batch recall by count
        if (countStr) {
          const count = Number(countStr);
          if (!Number.isFinite(count) || count < 1) {
            throw new Error("count must be a positive integer.");
          }

          const records = querySentMessages(account.accountId, { target, count });
          // 私聊消息的 msgseqid 为空，只需要有 messageid (即 msgkey) 即可撤回
          const recallable = records.filter((r) => r.messageid);

          if (recallable.length === 0) {
            return jsonResult({
              ok: true,
              channel: "infoflow",
              to,
              recalled: 0,
              message: "No recallable messages found in store.",
              _hint: "No messages found to recall. Briefly inform the user.",
            });
          }

          let succeeded = 0;
          let failed = 0;
          const recalledIds: string[] = [];
          const details: Array<{
            messageid: string;
            digest: string;
            ok: boolean;
            error?: string;
          }> = [];

          for (const record of recallable) {
            const result = await recallInfoflowPrivateMessage({
              account,
              msgkey: record.messageid,
              appAgentId,
            });

            if (result.ok) {
              succeeded++;
              recalledIds.push(record.messageid);
              details.push({ messageid: record.messageid, digest: record.digest, ok: true });
            } else {
              failed++;
              details.push({
                messageid: record.messageid,
                digest: record.digest,
                ok: false,
                error: result.error,
              });
            }
          }

          if (recalledIds.length > 0) {
            try {
              removeRecalledMessages(account.accountId, recalledIds);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: failed === 0,
            channel: "infoflow",
            to,
            recalled: succeeded,
            failed,
            total: recallable.length,
            details,
            _hint: failed === 0 ? RECALL_OK_HINT : RECALL_PARTIAL_HINT,
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // send
    // -----------------------------------------------------------------------
    if (action !== "send") {
      throw new Error(`Action "${action}" is not supported for Infoflow.`);
    }

    const account = resolveInfoflowAccount({ cfg, accountId: accountId ?? undefined });
    if (!account.config.appKey || !account.config.appSecret) {
      throw new Error("Infoflow appKey/appSecret not configured.");
    }

    const rawTo = readStringParam(params, "to", { required: true });
    if (!rawTo) {
      throw new Error("send requires a target (to).");
    }
    const to = normalizeInfoflowTarget(rawTo) ?? rawTo;
    const message = readStringParam(params, "message", { required: false, allowEmpty: true }) ?? "";
    const mediaUrl = readStringParam(params, "media", { trim: false });

    // Infoflow-specific mention params
    const atAll = params.atAll === true || params.atAll === "true";
    const mentionUserIdsRaw = readStringParam(params, "mentionUserIds");

    const isGroup = /^group:\d+$/i.test(to);
    const contents: InfoflowMessageContentItem[] = [];

    // Infoflow reply-to params (group only)
    const replyToMessageId = readStringParam(params, "replyToMessageId");
    const replyToPreview = readStringParam(params, "replyToPreview");
    const replyTypeRaw = readStringParam(params, "replyType");
    const replyTo: InfoflowOutboundReply | undefined =
      replyToMessageId && isGroup
        ? {
            messageid: replyToMessageId,
            preview: replyToPreview ?? undefined,
            replytype: replyTypeRaw === "2" ? "2" : "1",
          }
        : undefined;

    // Build AT content nodes (group messages only)
    if (isGroup) {
      if (atAll) {
        contents.push({ type: "at", content: "all" });
      } else if (mentionUserIdsRaw) {
        const userIds = mentionUserIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          contents.push({ type: "at", content: userIds.join(",") });
        }
      }
    }

    // Prepend @all/@user prefix to display text (same pattern as reply-dispatcher.ts)
    let messageText = message;
    if (isGroup) {
      if (atAll) {
        messageText = `@all ${message}`;
      } else if (mentionUserIdsRaw) {
        const userIds = mentionUserIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          const prefix = userIds.map((id) => `@${id}`).join(" ");
          messageText = `${prefix} ${message}`;
        }
      }
    }

    if (messageText.trim()) {
      contents.push({ type: "markdown", content: messageText });
    }

    if (mediaUrl) {
      logVerbose(
        `[infoflow:action:send] to=${to}, atAll=${atAll}, mentionUserIds=${mentionUserIdsRaw ?? "none"}`,
      );

      // b-mode: fire text first (if any), then image/link, then await all
      const p1 =
        contents.length > 0
          ? sendInfoflowMessage({
              cfg,
              to,
              contents,
              accountId: accountId ?? undefined,
              replyTo,
            })
          : null;
      let p2: Promise<{ ok: boolean; messageId?: string; error?: string }>;
      try {
        const prepared = await prepareInfoflowImageBase64({ mediaUrl });
        if (prepared.isImage) {
          p2 = sendInfoflowImageMessage({
            cfg,
            to,
            base64Image: prepared.base64,
            accountId: accountId ?? undefined,
            replyTo: contents.length > 0 ? undefined : replyTo,
          });
        } else {
          p2 = sendInfoflowMessage({
            cfg,
            to,
            contents: [{ type: "link", content: mediaUrl }],
            accountId: accountId ?? undefined,
            replyTo: contents.length > 0 ? undefined : replyTo,
          });
        }
      } catch {
        p2 = sendInfoflowMessage({
          cfg,
          to,
          contents: [{ type: "link", content: mediaUrl }],
          accountId: accountId ?? undefined,
          replyTo: contents.length > 0 ? undefined : replyTo,
        });
      }
      const results = await Promise.all([p1, p2].filter(Boolean));
      const last = results.at(-1) as
        | { ok: boolean; messageId?: string; error?: string }
        | undefined;
      return jsonResult({
        ok: last?.ok ?? false,
        channel: "infoflow",
        to,
        messageId: last?.messageId ?? (last?.ok ? "sent" : "failed"),
        ...(last?.error ? { error: last.error } : {}),
      });
    }

    if (contents.length === 0) {
      throw new Error("send requires text or media");
    }

    logVerbose(
      `[infoflow:action:send] to=${to}, atAll=${atAll}, mentionUserIds=${mentionUserIdsRaw ?? "none"}`,
    );

    const result = await sendInfoflowMessage({
      cfg,
      to,
      contents,
      accountId: accountId ?? undefined,
      replyTo,
    });

    return jsonResult({
      ok: result.ok,
      channel: "infoflow",
      to,
      messageId: result.messageId ?? (result.ok ? "sent" : "failed"),
      ...(result.error ? { error: result.error } : {}),
    });
  },
};
