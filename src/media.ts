/**
 * Infoflow native image sending: compress, base64-encode, and POST via Infoflow API.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { recordSentMessageId } from "./infoflow-req-parse.js";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { getInfoflowRuntime } from "./runtime.js";
import {
  getAppAccessToken,
  ensureHttps,
  extractIdFromRawJson,
  DEFAULT_TIMEOUT_MS,
  INFOFLOW_PRIVATE_SEND_PATH,
  INFOFLOW_GROUP_SEND_PATH,
} from "./send.js";
import { recordSentMessage, buildAgentFrom } from "./sent-message-store.js";
import type { ResolvedInfoflowAccount, InfoflowOutboundReply } from "./types.js";

/** Infoflow API image size limit: 1MB raw bytes */
const INFOFLOW_IMAGE_MAX_BYTES = 1 * 1024 * 1024;

// Compression grid: progressively smaller maxSide and quality
const COMPRESS_SIDES = [2048, 1536, 1280, 1024, 800];
const COMPRESS_QUALITIES = [80, 70, 60, 50, 40];

// ---------------------------------------------------------------------------
// Image compression
// ---------------------------------------------------------------------------

/**
 * Compresses an image buffer to fit within the Infoflow 1MB limit.
 * Returns null if compression fails (e.g. GIF > 1MB, or all combos exceed limit).
 */
export async function compressImageForInfoflow(params: {
  buffer: Buffer;
  contentType?: string;
}): Promise<Buffer | null> {
  const { buffer, contentType } = params;

  // Already within limit
  if (buffer.length <= INFOFLOW_IMAGE_MAX_BYTES) {
    return buffer;
  }

  // GIF cannot be compressed without losing animation
  if (contentType === "image/gif") {
    logVerbose(`[infoflow:media] GIF exceeds 1MB (${buffer.length} bytes), cannot compress`);
    return null;
  }

  const runtime = getInfoflowRuntime();
  let smallest: { buffer: Buffer; size: number } | null = null;

  for (const side of COMPRESS_SIDES) {
    for (const quality of COMPRESS_QUALITIES) {
      try {
        const out = await runtime.media.resizeToJpeg({
          buffer,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (size <= INFOFLOW_IMAGE_MAX_BYTES) {
          logVerbose(
            `[infoflow:media] compressed ${buffer.length} → ${size} bytes (side≤${side}, q=${quality})`,
          );
          return out;
        }
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size };
        }
      } catch {
        // skip failed combo
      }
    }
  }

  logVerbose(
    `[infoflow:media] all compression combos exceed 1MB (smallest: ${smallest?.size ?? "N/A"} bytes)`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// Prepare image as base64
// ---------------------------------------------------------------------------

export type PrepareImageResult = { isImage: true; base64: string } | { isImage: false };

/**
 * Downloads media, checks if it's an image, compresses to 1MB, and base64-encodes.
 */
export async function prepareInfoflowImageBase64(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
}): Promise<PrepareImageResult> {
  const { mediaUrl, mediaLocalRoots } = params;
  const runtime = getInfoflowRuntime();

  // Download media
  const loaded = await runtime.media.loadWebMedia(mediaUrl, {
    maxBytes: 30 * 1024 * 1024, // 30MB download limit
    optimizeImages: false,
    localRoots: mediaLocalRoots?.length ? mediaLocalRoots : undefined,
  });

  // Check if it's an image
  const kind = runtime.media.mediaKindFromMime(loaded.contentType ?? undefined);
  if (kind !== "image") {
    return { isImage: false };
  }

  // Compress if needed
  const compressed = await compressImageForInfoflow({
    buffer: loaded.buffer,
    contentType: loaded.contentType ?? undefined,
  });

  if (!compressed) {
    return { isImage: false }; // compression failed, fall back to link
  }

  return { isImage: true, base64: compressed.toString("base64") };
}

// ---------------------------------------------------------------------------
// Send image messages
// ---------------------------------------------------------------------------

/**
 * Sends a native image message to a group chat.
 */
export async function sendInfoflowGroupImage(params: {
  account: ResolvedInfoflowAccount;
  groupId: number;
  base64Image: string;
  replyTo?: InfoflowOutboundReply;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; messageid?: string }> {
  const { account, groupId, base64Image, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendGroupImage] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const payload = {
      message: {
        header: {
          toid: groupId,
          totype: "GROUP",
          msgtype: "IMAGE",
          clientmsgid: Date.now(),
          role: "robot",
        },
        body: [{ type: "IMAGE", content: base64Image }],
        ...(params.replyTo
          ? {
              reply: {
                messageid: params.replyTo.messageid,
                preview: params.replyTo.preview ?? "",
                replytype: params.replyTo.replytype ?? "1",
              },
            }
          : {}),
      },
    };

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json",
    };

    logVerbose(
      `[infoflow:sendGroupImage] POST to group ${groupId}, image size: ${base64Image.length} chars`,
    );

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_GROUP_SEND_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await res.text();
    const data = JSON.parse(responseText) as Record<string, unknown>;
    logVerbose(`[infoflow:sendGroupImage] response: status=${res.status}, data=${responseText}`);

    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:sendGroupImage] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:sendGroupImage] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Extract IDs from raw text to preserve large integer precision
    const messageid =
      extractIdFromRawJson(responseText, "messageid") ??
      extractIdFromRawJson(responseText, "msgid");
    const msgseqid = extractIdFromRawJson(responseText, "msgseqid");
    if (messageid) {
      recordSentMessageId(messageid);
      try {
        recordSentMessage(account.accountId, {
          target: `group:${groupId}`,
          from: buildAgentFrom(account.config.appAgentId),
          messageid,
          msgseqid: msgseqid ?? "",
          digest: "image",
          sentAt: Date.now(),
        });
      } catch {
        // Do not block sending
      }
    }

    return { ok: true, messageid };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:sendGroupImage] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends a native image message to a private (DM) chat.
 */
export async function sendInfoflowPrivateImage(params: {
  account: ResolvedInfoflowAccount;
  toUser: string;
  base64Image: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; msgkey?: string }> {
  const { account, toUser, base64Image, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendPrivateImage] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const payload = {
      touser: toUser,
      msgtype: "image",
      image: { content: base64Image },
    };

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json",
    };

    logVerbose(
      `[infoflow:sendPrivateImage] POST to user ${toUser}, image size: ${base64Image.length} chars`,
    );

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_PRIVATE_SEND_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await res.text();
    const data = JSON.parse(responseText) as Record<string, unknown>;
    logVerbose(`[infoflow:sendPrivateImage] response: status=${res.status}, data=${responseText}`);

    if (data.errcode && data.errcode !== 0) {
      const errMsg = String(data.errmsg ?? `errcode ${data.errcode}`);
      getInfoflowSendLog().error(`[infoflow:sendPrivateImage] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Extract msgkey from raw text to preserve large integer precision
    const msgkey =
      extractIdFromRawJson(responseText, "msgkey") ??
      (data.msgkey != null ? String(data.msgkey) : undefined);
    if (msgkey) {
      recordSentMessageId(msgkey);
      try {
        recordSentMessage(account.accountId, {
          target: toUser,
          from: buildAgentFrom(account.config.appAgentId),
          messageid: msgkey,
          msgseqid: "",
          digest: "image",
          sentAt: Date.now(),
        });
      } catch {
        // Do not block sending
      }
    }

    return { ok: true, msgkey };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:sendPrivateImage] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Unified image message sender. Parses target and dispatches to group or private.
 */
export async function sendInfoflowImageMessage(params: {
  cfg: OpenClawConfig;
  to: string;
  base64Image: string;
  accountId?: string;
  replyTo?: InfoflowOutboundReply;
}): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const { cfg, to, base64Image, accountId } = params;
  const account = resolveInfoflowAccount({ cfg, accountId });

  // Parse target: remove "infoflow:" prefix if present
  const target = to.replace(/^infoflow:/i, "");

  const groupMatch = target.match(/^group:(\d+)/i);
  if (groupMatch) {
    const groupId = Number(groupMatch[1]);
    const result = await sendInfoflowGroupImage({
      account,
      groupId,
      base64Image,
      replyTo: params.replyTo,
    });
    return { ok: result.ok, error: result.error, messageId: result.messageid };
  }

  // Private message (replyTo not supported)
  const result = await sendInfoflowPrivateImage({ account, toUser: target, base64Image });
  return { ok: result.ok, error: result.error, messageId: result.msgkey };
}
