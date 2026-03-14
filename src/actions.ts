/**
 * Infoflow channel message actions adapter.
 * Intercepts the "send" action from the message tool to support
 * @all and @user mentions in group messages.
 */

import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { extractToolSend, jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
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
} from "./sent-message-store.js";
import { normalizeInfoflowTarget } from "./targets.js";
import type { InfoflowMessageContentItem, InfoflowOutboundReply } from "./types.js";

// Recall result hint constants — reused across single/batch, group/private recall paths
const RECALL_OK_HINT = "Recall succeeded. output only NO_REPLY with no other text.";
const RECALL_FAIL_HINT = "Recall failed. Send a brief reply stating only the failure reason.";
const RECALL_PARTIAL_HINT =
  "Some recalls failed. Send a brief reply stating only the failure reason(s).";

export const infoflowMessageActions: ChannelMessageActionAdapter = {
  listActions: (): ChannelMessageActionName[] => ["send", "delete"],

  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),

  handleAction: async ({ action, params, cfg, accountId }) => {
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

      const messageId = readStringParam(params, "messageId");
      // Default to count=1 (recall latest message) when neither messageId nor count is provided
      const countStr = readStringParam(params, "count") ?? (messageId ? undefined : "1");

      const groupMatch = target.match(/^group:(\d+)/i);

      if (groupMatch) {
        // -----------------------------------------------------------------
        // 群消息撤回
        // -----------------------------------------------------------------
        const groupId = Number(groupMatch[1]);

        // Mode A: single message recall by messageId
        if (messageId) {
          let msgseqid = readStringParam(params, "msgseqid") ?? "";
          if (!msgseqid) {
            const stored = findSentMessage(account.accountId, messageId);
            if (stored?.msgseqid) {
              msgseqid = stored.msgseqid;
            }
          }
          if (!msgseqid) {
            throw new Error(
              "delete requires msgseqid (not found in store; provide it explicitly or send messages first).",
            );
          }

          const result = await recallInfoflowGroupMessage({
            account,
            groupId,
            messageid: messageId,
            msgseqid,
          });

          if (result.ok) {
            try {
              removeRecalledMessages(account.accountId, [messageId]);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: result.ok,
            channel: "infoflow",
            to,
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
            target: `group:${groupId}`,
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

        // Mode A: single message recall by messageId (msgkey)
        if (messageId) {
          const result = await recallInfoflowPrivateMessage({
            account,
            msgkey: messageId,
            appAgentId,
          });

          if (result.ok) {
            try {
              removeRecalledMessages(account.accountId, [messageId]);
            } catch {
              // ignore cleanup errors
            }
          }

          return jsonResult({
            ok: result.ok,
            channel: "infoflow",
            to,
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
