/**
 * Infoflow channel message actions adapter.
 * Intercepts the "send" action from the message tool to support
 * @all and @user mentions in group messages.
 */

import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { extractToolSend, jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { logVerbose } from "./logging.js";
import { sendInfoflowMessage } from "./send.js";
import { normalizeInfoflowTarget } from "./targets.js";
import type { InfoflowMessageContentItem } from "./types.js";

export const infoflowMessageActions: ChannelMessageActionAdapter = {
  listActions: (): ChannelMessageActionName[] => ["send"],

  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),

  handleAction: async ({ action, params, cfg, accountId }) => {
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
      contents.push({ type: "link", content: mediaUrl });
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
