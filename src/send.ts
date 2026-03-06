/**
 * Outbound send API: POST messages to the Infoflow service.
 * Supports both private (DM) and group chat messages.
 */

import { createHash, randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { recordSentMessageId } from "./infoflow-req-parse.js";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import { recordSentMessage, buildMessageDigest, buildAgentFrom } from "./sent-message-store.js";
import type {
  InfoflowGroupMessageBodyItem,
  InfoflowMessageContentItem,
  InfoflowOutboundReply,
  ResolvedInfoflowAccount,
} from "./types.js";

export const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Ensures apiHost uses HTTPS for security (secrets in transit).
 * Allows HTTP only for localhost/127.0.0.1 (local development).
 */
export function ensureHttps(apiHost: string): string {
  if (apiHost.startsWith("http://")) {
    const url = new URL(apiHost);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal) {
      return apiHost.replace(/^http:/, "https:");
    }
  }
  return apiHost;
}

// Infoflow API paths (host is configured via apiHost in config)
const INFOFLOW_AUTH_PATH = "/api/v1/auth/app_access_token";
export const INFOFLOW_PRIVATE_SEND_PATH = "/api/v1/app/message/send";
export const INFOFLOW_GROUP_SEND_PATH = "/api/v1/robot/msg/groupmsgsend";
export const INFOFLOW_GROUP_RECALL_PATH = "/api/v1/robot/group/msgRecall";
export const INFOFLOW_PRIVATE_RECALL_PATH = "/api/v1/app/message/revoke";

// Token cache to avoid fetching token for every message
// Use Map keyed by appKey to support multi-account isolation
const tokenCacheMap = new Map<string, { token: string; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Parses link content format: "href" or "[label]href"
 * Returns both href and label (label defaults to href if not specified)
 */
function parseLinkContent(content: string): { href: string; label: string } {
  if (content.startsWith("[")) {
    const closeBracket = content.indexOf("]");
    if (closeBracket > 1) {
      return {
        label: content.slice(1, closeBracket),
        href: content.slice(closeBracket + 1),
      };
    }
  }
  return { href: content, label: content };
}

/**
 * Checks if a string looks like a local file path rather than a URL.
 * Mirrors the pattern from src/media/parse.ts; security validation is
 * deferred to the load layer (loadWebMedia).
 */
function isLikelyLocalPath(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~")
  );
}

/**
 * Extracts a numeric or string value for the given key from raw JSON text.
 * This bypasses JSON.parse precision loss for large integers (>2^53).
 * Matches both bare integers ("key": 123) and quoted strings ("key": "abc").
 */
export function extractIdFromRawJson(rawJson: string, key: string): string | undefined {
  // Match bare integer: "key": 12345
  const reNum = new RegExp(`"${key}"\\s*:\\s*(\\d+)`);
  const mNum = rawJson.match(reNum);
  if (mNum) return mNum[1];
  // Match quoted string: "key": "value"
  const reStr = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`);
  const mStr = rawJson.match(reStr);
  return mStr?.[1];
}

/**
 * Extracts message ID from Infoflow API response data.
 * Handles different response formats:
 * - Private: data.msgkey
 * - Group: data.data.messageid or data.data.msgid (nested)
 * - Fallback: data.messageid or data.msgid (flat)
 */
export function extractMessageId(data: Record<string, unknown>): string | undefined {
  // Try data.msgkey (private message format)
  if (data.msgkey != null) {
    return String(data.msgkey);
  }

  // Try nested data.data structure (group message format)
  const innerData = data.data as Record<string, unknown> | undefined;
  if (innerData && typeof innerData === "object") {
    // Try data.data.messageid
    if (innerData.messageid != null) {
      return String(innerData.messageid);
    }
    // Try data.data.msgid
    if (innerData.msgid != null) {
      return String(innerData.msgid);
    }
  }

  // Fallback: try flat structure
  if (data.messageid != null) {
    return String(data.messageid);
  }
  if (data.msgid != null) {
    return String(data.msgid);
  }

  return undefined;
}

/**
 * Extracts msgseqid from Infoflow group send API response data.
 * The recall API requires this alongside messageid.
 */
export function extractMsgSeqId(data: Record<string, unknown>): string | undefined {
  // Try nested data.data structure (group message format)
  const innerData = data.data as Record<string, unknown> | undefined;
  if (innerData && typeof innerData === "object" && innerData.msgseqid != null) {
    return String(innerData.msgseqid);
  }

  // Fallback: flat structure
  if (data.msgseqid != null) {
    return String(data.msgseqid);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

/**
 * Gets the app access token from Infoflow API.
 * Token is cached and reused until expiry.
 */
export async function getAppAccessToken(params: {
  apiHost: string;
  appKey: string;
  appSecret: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; token?: string; error?: string }> {
  const { apiHost, appKey, appSecret, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  // Check cache first (by appKey for multi-account isolation)
  const cached = tokenCacheMap.get(appKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    // app_secret needs to be MD5 hashed (lowercase)
    const md5Secret = createHash("md5").update(appSecret).digest("hex").toLowerCase();

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_AUTH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: appKey, app_secret: md5Secret }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as Record<string, unknown>;

    if (data.errcode && data.errcode !== 0) {
      const errMsg = String(data.errmsg ?? `errcode ${data.errcode}`);
      return { ok: false, error: errMsg };
    }

    const dataField = data.data as { app_access_token?: string; expires_in?: number } | undefined;
    const token = dataField?.app_access_token;
    const expiresIn = dataField?.expires_in ?? 7200; // default 2 hours

    if (!token) {
      return { ok: false, error: "no token in response" };
    }

    // Cache token by appKey (with 5 minute buffer before expiry)
    tokenCacheMap.set(appKey, {
      token,
      expiresAt: Date.now() + (expiresIn - 300) * 1000,
    });

    return { ok: true, token };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Private Chat (DM) Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a private (DM) message to a user.
 * @param account - Resolved Infoflow account with config
 * @param toUser - Recipient's uuapName (email prefix), multiple users separated by |
 * @param contents - Array of content items (text/markdown; "at" is ignored for private messages)
 */
export async function sendInfoflowPrivateMessage(params: {
  account: ResolvedInfoflowAccount;
  toUser: string;
  contents: InfoflowMessageContentItem[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; invaliduser?: string; msgkey?: string }> {
  const { account, toUser, contents, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  // Validate account config
  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Check if contents contain link type
  const hasLink = contents.some((item) => item.type.toLowerCase() === "link");

  // Get token first
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendPrivate] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    let payload: Record<string, unknown>;

    if (hasLink) {
      // Build richtext format payload when link is present
      const richtextContent: Array<{ type: string; text?: string; href?: string; label?: string }> =
        [];

      for (const item of contents) {
        const type = item.type.toLowerCase();
        if (type === "text") {
          richtextContent.push({ type: "text", text: item.content });
        } else if (type === "md" || type === "markdown") {
          richtextContent.push({ type: "text", text: item.content });
        } else if (type === "link") {
          if (item.content) {
            const { href, label } = parseLinkContent(item.content);
            richtextContent.push({ type: "a", href, label });
          }
        }
      }

      if (richtextContent.length === 0) {
        return { ok: false, error: "no valid content for private message" };
      }

      payload = {
        touser: toUser,
        msgtype: "richtext",
        richtext: { content: richtextContent },
      };
    } else {
      // Original logic: filter text/markdown contents and merge with '\n'
      const textParts: string[] = [];
      let hasMarkdown = false;

      for (const item of contents) {
        const type = item.type.toLowerCase();
        if (type === "text") {
          textParts.push(item.content);
        } else if (type === "md" || type === "markdown") {
          textParts.push(item.content);
          hasMarkdown = true;
        }
      }

      if (textParts.length === 0) {
        return { ok: false, error: "no valid content for private message" };
      }

      const mergedContent = textParts.join("\n");
      const msgtype: string = hasMarkdown ? "md" : "text";

      payload = { touser: toUser, msgtype };
      if (msgtype === "text") {
        payload.text = { content: mergedContent };
      } else {
        payload.md = { content: mergedContent };
      }
    }

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json; charset=utf-8",
      LOGID: randomUUID(),
    };

    const bodyStr = JSON.stringify(payload);

    // Log request URL and body when verbose logging is enabled
    logVerbose(`[infoflow:sendPrivate] POST body: ${bodyStr}`);

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_PRIVATE_SEND_PATH}`, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    const responseText = await res.text();
    const data = JSON.parse(responseText) as Record<string, unknown>;
    logVerbose(`[infoflow:sendPrivate] response: status=${res.status}, data=${responseText}`);

    // Check outer code first
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:sendPrivate] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // Check inner data.errcode
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:sendPrivate] failed: ${errMsg}`);
      return {
        ok: false,
        error: errMsg,
        invaliduser: innerData?.invaliduser as string | undefined,
      };
    }

    // Extract message ID from raw text to preserve large integer precision
    const msgkey =
      extractIdFromRawJson(responseText, "msgkey") ??
      extractIdFromRawJson(responseText, "messageid") ??
      extractMessageId(innerData ?? {});
    if (msgkey) {
      recordSentMessageId(msgkey);
      try {
        recordSentMessage(account.accountId, {
          target: toUser,
          from: buildAgentFrom(account.config.appAgentId),
          messageid: msgkey,
          msgseqid: "",
          digest: buildMessageDigest(contents),
          sentAt: Date.now(),
        });
      } catch {
        // Do not block sending
      }
    }

    return { ok: true, invaliduser: innerData?.invaliduser as string | undefined, msgkey };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:sendPrivate] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Group Chat Message Sending
// ---------------------------------------------------------------------------

/**
 * Sends a group chat message.
 * @param account - Resolved Infoflow account with config
 * @param groupId - Target group ID (numeric)
 * @param contents - Array of content items (text/markdown/at)
 */
export async function sendInfoflowGroupMessage(params: {
  account: ResolvedInfoflowAccount;
  groupId: number;
  contents: InfoflowMessageContentItem[];
  replyTo?: InfoflowOutboundReply;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; messageid?: string; msgseqid?: string }> {
  const { account, groupId, contents, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  // Validate account config
  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Validate contents
  if (contents.length === 0) {
    return { ok: false, error: "contents array is empty" };
  }

  // Build group message body from contents
  let hasMarkdown = false;
  const body: InfoflowGroupMessageBodyItem[] = [];
  for (const item of contents) {
    const type = item.type.toLowerCase();
    if (type === "text") {
      body.push({ type: "TEXT", content: item.content });
    } else if (type === "md" || type === "markdown") {
      body.push({ type: "MD", content: item.content });
      hasMarkdown = true;
    } else if (type === "at") {
      // Parse AT content: "all" means atall, otherwise comma-separated user IDs
      if (item.content === "all") {
        body.push({ type: "AT", atall: true, atuserids: [] });
      } else {
        const userIds = item.content
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (userIds.length > 0) {
          body.push({ type: "AT", atuserids: userIds });
        }
      }
    } else if (type === "link") {
      // Group messages only use href (label is ignored)
      if (item.content) {
        const { href } = parseLinkContent(item.content);
        body.push({ type: "LINK", href });
      }
    } else if (type === "at-agent") {
      // Robot AT: parse comma-separated numeric IDs into atagentids
      const agentIds = item.content
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Number.isFinite);
      if (agentIds.length > 0) {
        body.push({ type: "AT", atuserids: [], atagentids: agentIds });
      }
    } else if (type === "image") {
      body.push({ type: "IMAGE", content: item.content });
    }
  }

  // Split body: LINK and IMAGE must be sent as individual messages
  const linkItems = body.filter((b) => b.type === "LINK");
  const imageItems = body.filter((b) => b.type === "IMAGE");
  const textItems = body.filter((b) => b.type !== "LINK" && b.type !== "IMAGE");

  // Get token first (shared by all sends)
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:sendGroup] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  // NOTE: Infoflow API requires "Bearer-<token>" format (with hyphen, not space).
  // This is a non-standard format specific to Infoflow service. Do not modify
  // unless the Infoflow API specification changes.
  const headers = {
    Authorization: `Bearer-${tokenResult.token}`,
    "Content-Type": "application/json",
  };

  let msgIndex = 0;

  // Helper: post a single group message payload
  const postGroupMessage = async (
    msgBody: InfoflowGroupMessageBodyItem[],
    msgtype: string,
    replyTo?: InfoflowOutboundReply,
  ): Promise<{ ok: boolean; error?: string; messageid?: string; msgseqid?: string }> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);

      const payload = {
        message: {
          header: {
            toid: groupId,
            totype: "GROUP",
            msgtype,
            clientmsgid: Date.now() + msgIndex++,
            role: "robot",
          },
          body: msgBody,
          ...(replyTo
            ? {
                reply: {
                  messageid: replyTo.messageid,
                  preview: replyTo.preview ?? "",
                  replytype: replyTo.replytype ?? "1",
                },
              }
            : {}),
        },
      };

      const bodyStr = JSON.stringify(payload);
      logVerbose(`[infoflow:sendGroup] POST body: ${bodyStr}`);

      const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_GROUP_SEND_PATH}`, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      const responseText = await res.text();
      const data = JSON.parse(responseText) as Record<string, unknown>;
      logVerbose(`[infoflow:sendGroup] response: status=${res.status}, data=${responseText}`);

      const code = typeof data.code === "string" ? data.code : "";
      if (code !== "ok") {
        const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
        getInfoflowSendLog().error(`[infoflow:sendGroup] failed: ${errMsg}`);
        return { ok: false, error: errMsg };
      }

      const innerData = data.data as Record<string, unknown> | undefined;
      const errcode = innerData?.errcode;
      if (errcode != null && errcode !== 0) {
        const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
        getInfoflowSendLog().error(`[infoflow:sendGroup] failed: ${errMsg}`);
        return { ok: false, error: errMsg };
      }

      // Extract IDs from raw text to preserve large integer precision
      const messageid =
        extractIdFromRawJson(responseText, "messageid") ??
        extractIdFromRawJson(responseText, "msgid");
      const msgseqid = extractIdFromRawJson(responseText, "msgseqid");
      if (messageid) {
        recordSentMessageId(messageid);
      }

      return { ok: true, messageid, msgseqid };
    } catch (err) {
      const errMsg = formatInfoflowError(err);
      getInfoflowSendLog().error(`[infoflow:sendGroup] exception: ${errMsg}`);
      return { ok: false, error: errMsg };
    } finally {
      clearTimeout(timeout);
    }
  };

  // Helper: record a successful sub-message to the persistent store
  const recordToStore = (
    result: { messageid?: string; msgseqid?: string },
    digestContents: InfoflowMessageContentItem[],
  ) => {
    if (!result.messageid) return;
    try {
      recordSentMessage(account.accountId, {
        target: `group:${groupId}`,
        from: buildAgentFrom(account.config.appAgentId),
        messageid: result.messageid,
        msgseqid: result.msgseqid ?? "",
        digest: buildMessageDigest(digestContents),
        sentAt: Date.now(),
      });
    } catch {
      // Do not block sending
    }
  };

  let lastMessageId: string | undefined;
  let lastMsgSeqId: string | undefined;
  let firstError: string | undefined;
  let replyApplied = false;

  // 1) Send text/AT/MD items together (if any)
  if (textItems.length > 0) {
    const msgtype = hasMarkdown ? "MD" : "TEXT";
    const result = await postGroupMessage(
      textItems,
      msgtype,
      !replyApplied ? params.replyTo : undefined,
    );
    replyApplied = true;
    if (result.ok) {
      lastMessageId = result.messageid;
      lastMsgSeqId = result.msgseqid;
      const digestItems = contents.filter((c) => !["link", "image"].includes(c.type.toLowerCase()));
      recordToStore(result, digestItems);
    } else if (!firstError) {
      firstError = result.error;
    }
  }

  // 2) Send each LINK as a separate message
  for (const linkItem of linkItems) {
    const result = await postGroupMessage(
      [linkItem],
      "TEXT",
      !replyApplied ? params.replyTo : undefined,
    );
    replyApplied = true;
    if (result.ok) {
      lastMessageId = result.messageid;
      lastMsgSeqId = result.msgseqid;
      recordToStore(result, [{ type: "link", content: linkItem.href }]);
    } else if (!firstError) {
      firstError = result.error;
    }
  }

  // 3) Send each IMAGE as a separate message
  for (const imageItem of imageItems) {
    const result = await postGroupMessage(
      [imageItem],
      "IMAGE",
      !replyApplied ? params.replyTo : undefined,
    );
    replyApplied = true;
    if (result.ok) {
      lastMessageId = result.messageid;
      lastMsgSeqId = result.msgseqid;
      recordToStore(result, [{ type: "image", content: "" }]);
    } else if (!firstError) {
      firstError = result.error;
    }
  }

  if (firstError) {
    return { ok: false, error: firstError, messageid: lastMessageId, msgseqid: lastMsgSeqId };
  }
  return { ok: true, messageid: lastMessageId, msgseqid: lastMsgSeqId };
}

// ---------------------------------------------------------------------------
// Group Message Recall (撤回)
// ---------------------------------------------------------------------------

/**
 * Recalls (撤回) a group message previously sent by the robot.
 * Only group messages can be recalled via this API.
 */
export async function recallInfoflowGroupMessage(params: {
  account: ResolvedInfoflowAccount;
  groupId: number;
  messageid: string;
  msgseqid: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { account, groupId, messageid, msgseqid, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  // 验证必要的认证配置
  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // 获取应用访问令牌
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:recallGroup] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    // 手动构建 JSON 以保持 messageid/msgseqid 为原始整数，避免 JavaScript Number 精度丢失
    const bodyStr = `{"groupId":${groupId},"messageid":${messageid},"msgseqid":${msgseqid}}`;

    logVerbose(`[infoflow:recallGroup] POST token: ${tokenResult.token} body: ${bodyStr}`);

    // 发送撤回请求
    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_GROUP_RECALL_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer-${tokenResult.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: bodyStr,
      signal: controller.signal,
    });

    const data = JSON.parse(await res.text()) as Record<string, unknown>;
    logVerbose(
      `[infoflow:recallGroup] response: status=${res.status}, data=${JSON.stringify(data)}`,
    );

    // 检查外层响应码
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:recallGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // 检查内层错误码
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:recallGroup] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:recallGroup] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Private Message Recall (撤回)
// ---------------------------------------------------------------------------

/**
 * Recalls (撤回) a private message previously sent by the app.
 * Uses the /api/v1/app/message/revoke endpoint.
 */
export async function recallInfoflowPrivateMessage(params: {
  account: ResolvedInfoflowAccount;
  /** 发送消息时返回的 msgkey（存储于 sent-message-store 的 messageid 字段） */
  msgkey: string;
  /** 如流企业后台"应用ID" */
  appAgentId: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { account, msgkey, appAgentId, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const { apiHost, appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:recallPrivate] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const bodyStr = JSON.stringify({ msgkey, agentid: appAgentId });

    logVerbose(`[infoflow:recallPrivate] POST auth: ${tokenResult.token} body: ${bodyStr}`);

    const res = await fetch(`${ensureHttps(apiHost)}${INFOFLOW_PRIVATE_RECALL_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer-${tokenResult.token}`,
        "Content-Type": "application/json; charset=utf-8",
        LOGID: String(Date.now()),
      },
      body: bodyStr,
      signal: controller.signal,
    });

    const data = JSON.parse(await res.text()) as Record<string, unknown>;
    logVerbose(
      `[infoflow:recallPrivate] response: status=${res.status}, data=${JSON.stringify(data)}`,
    );

    // 检查外层响应码
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:recallPrivate] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // 检查内层错误码
    const innerData = data.data as Record<string, unknown> | undefined;
    const errcode = innerData?.errcode;
    if (errcode != null && errcode !== 0) {
      const errMsg = String(innerData?.errmsg ?? `errcode ${errcode}`);
      getInfoflowSendLog().error(`[infoflow:recallPrivate] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:recallPrivate] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Local Image Link Resolution
// ---------------------------------------------------------------------------

/**
 * Pre-processes content items: for "link" items pointing to local file paths,
 * checks if the file is an image and converts to "image" type with base64 content.
 * Falls back to original "link" type if not an image or on error.
 */
async function resolveLocalImageLinks(
  contents: InfoflowMessageContentItem[],
): Promise<InfoflowMessageContentItem[]> {
  const hasLocalLinks = contents.some(
    (item) => item.type === "link" && isLikelyLocalPath(parseLinkContent(item.content).href),
  );
  if (!hasLocalLinks) {
    return contents;
  }

  // Dynamic import to avoid circular dependency (media.ts imports from send.ts)
  const { prepareInfoflowImageBase64 } = await import("./media.js");

  const resolved: InfoflowMessageContentItem[] = [];
  for (const item of contents) {
    if (item.type !== "link") {
      resolved.push(item);
      continue;
    }

    const { href } = parseLinkContent(item.content);
    if (!isLikelyLocalPath(href)) {
      resolved.push(item);
      continue;
    }

    // Attempt image detection for local path
    try {
      const prepared = await prepareInfoflowImageBase64({ mediaUrl: href });
      if (prepared.isImage) {
        resolved.push({ type: "image", content: prepared.base64 });
        continue;
      }
    } catch {
      logVerbose(`[infoflow:send] local image detection failed for ${href}, sending as link`);
    }
    resolved.push(item);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Unified Message Sending
// ---------------------------------------------------------------------------

/**
 * Unified message sending entry point.
 * Parses the `to` target and dispatches to group or private message sending.
 * Local file path links that are images are automatically sent as native images.
 * @param cfg - OpenClaw config
 * @param to - Target: "username" for private, "group:123" for group
 * @param contents - Array of content items (text/markdown/at)
 * @param accountId - Optional account ID for multi-account support
 * @param replyTo - Optional reply context for group messages (ignored for private)
 */
export async function sendInfoflowMessage(params: {
  cfg: OpenClawConfig;
  to: string;
  contents: InfoflowMessageContentItem[];
  accountId?: string;
  replyTo?: InfoflowOutboundReply;
}): Promise<{ ok: boolean; error?: string; messageId?: string; msgseqid?: string }> {
  const { cfg, to, contents, accountId } = params;

  // Resolve account config
  const account = resolveInfoflowAccount({ cfg, accountId });
  const { appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // Validate contents
  if (contents.length === 0) {
    return { ok: false, error: "contents array is empty" };
  }

  // Pre-process: convert local-path link items to native image items if they're images
  const resolvedContents = await resolveLocalImageLinks(contents);

  // Parse target: remove "infoflow:" prefix if present
  const target = to.replace(/^infoflow:/i, "");

  // Check if target is a group (format: group:123)
  const groupMatch = target.match(/^group:(\d+)/i);
  if (groupMatch) {
    // Group path: sendInfoflowGroupMessage already handles IMAGE items
    const groupId = Number(groupMatch[1]);
    const result = await sendInfoflowGroupMessage({
      account,
      groupId,
      contents: resolvedContents,
      replyTo: params.replyTo,
    });
    return {
      ok: result.ok,
      error: result.error,
      messageId: result.messageid,
      msgseqid: result.msgseqid,
    };
  }

  // Private path: split image items (sendInfoflowPrivateMessage doesn't handle image type)
  const imageItems = resolvedContents.filter((c) => c.type === "image");
  const nonImageContents = resolvedContents.filter((c) => c.type !== "image");

  let lastMessageId: string | undefined;
  let firstError: string | undefined;

  // Send non-image contents via private message API
  if (nonImageContents.length > 0) {
    const result = await sendInfoflowPrivateMessage({
      account,
      toUser: target,
      contents: nonImageContents,
    });
    if (result.ok) {
      lastMessageId = result.msgkey;
    } else {
      firstError = result.error;
    }
  }

  // Send image items as native private images
  if (imageItems.length > 0) {
    const { sendInfoflowPrivateImage } = await import("./media.js");
    for (const imgItem of imageItems) {
      const result = await sendInfoflowPrivateImage({
        account,
        toUser: target,
        base64Image: imgItem.content,
      });
      if (result.ok) {
        lastMessageId = result.msgkey;
      } else if (!firstError) {
        firstError = result.error;
      }
    }
  }

  if (firstError && !lastMessageId) {
    return { ok: false, error: firstError };
  }
  return { ok: true, messageId: lastMessageId };
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal — not part of the public API)
// ---------------------------------------------------------------------------

/** @internal — Clears the token cache. Only use in tests. */
export function _resetTokenCache(): void {
  tokenCacheMap.clear();
}
