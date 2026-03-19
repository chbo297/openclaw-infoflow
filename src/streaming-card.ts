/**
 * Infoflow Streaming Card API
 * 如流气泡卡（流式卡片）接口封装
 *
 * 基于知识库文档: https://ku.baidu-int.com/knowledge/HFVrC7hq1Q/2tsPs8CtSd/Bu7DDg4dpB/Ip2DAm5gcgBVjp
 *
 * 流程：
 * 1. 创建卡片 (createStreamingCard) → 返回 modify_token
 * 2. 更新卡片 (updateStreamingCard) → 使用 modify_token 更新内容
 * 3. 结束流式 (finalizeStreamingCard) → 发送结束标记
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveInfoflowAccount } from "./accounts.js";
import { getAppAccessToken, ensureHttps, DEFAULT_TIMEOUT_MS } from "./send.js";
import { getInfoflowSendLog, formatInfoflowError, logVerbose } from "./logging.js";
import type { ResolvedInfoflowAccount } from "./types.js";

// ---------------------------------------------------------------------------
// API Paths
// ---------------------------------------------------------------------------

/** 创建流式卡片接口 */
const STREAMING_CARD_CREATE_PATH = "/api/v1/msg/sender/interactivity_msg";

/** 更新流式卡片接口（单人视角） */
const STREAMING_CARD_UPDATE_PERSONAL_PATH = "/api/v1/msg/modifier/interactivity_personal_msg_content";

/** 更新流式卡片接口（群聊视角） */
const STREAMING_CARD_UPDATE_GROUP_PATH = "/api/v1/msg/modifier/dynamic_content";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 流式卡片内容项 */
export type StreamingCardContentItem = {
  type: "text";
  content: string;
};

/** 流式卡片内容集合 */
export type StreamingCardContents = {
  /** 初始化标记（思考中状态） */
  card_init?: StreamingCardContentItem;
  /** AI Markdown 内容 */
  ai_markdown?: StreamingCardContentItem;
  /** AI 文本内容 */
  ai_text?: StreamingCardContentItem;
  /** 普通文本 */
  text?: StreamingCardContentItem;
  /** 状态信息（如"使用【查询插件】..."） */
  status_info?: StreamingCardContentItem;
  /** 流式结束标记 */
  dc_print_end?: StreamingCardContentItem;
  /** 思考状态图标 */
  think_star_img?: StreamingCardContentItem;
  think_status_img?: StreamingCardContentItem;
  think_status_color?: StreamingCardContentItem;
  think_status_text?: StreamingCardContentItem;
  think_layout_install?: StreamingCardContentItem;
  /** 赞踩区域 */
  feedbackLayoutInstall?: StreamingCardContentItem;
  /** 其他动态内容 */
  [key: string]: StreamingCardContentItem | undefined;
};

/** 创建流式卡片的参数 */
export type CreateStreamingCardParams = {
  cfg: OpenClawConfig;
  /** 接收者ID：用户名或群号 */
  receiverId: string;
  /** 接收者类型 */
  receiverType: "user" | "group";
  /** 初始内容（可选，默认显示思考中） */
  initialContent?: string;
  /** 离线通知文本 */
  offlineNotifyText?: string;
  /** 业务上下文（回调时透传） */
  appContext?: Record<string, unknown>;
  /** 账号ID */
  accountId?: string;
  timeoutMs?: number;
};

/** 创建流式卡片的返回 */
export type CreateStreamingCardResult = {
  ok: boolean;
  error?: string;
  /** 修改令牌，用于后续更新 */
  modifyToken?: string;
  /** 消息ID */
  messageId?: string;
};

/** 更新流式卡片的参数 */
export type UpdateStreamingCardParams = {
  cfg: OpenClawConfig;
  /** 修改令牌 */
  modifyToken: string;
  /** 接收者类型 */
  receiverType: "user" | "group";
  /** 新的内容 */
  contents: StreamingCardContents;
  /** 用户ID列表（仅 user 类型需要） */
  userIds?: string[];
  /** 群聊ID（仅 group 类型需要，用于 notify_list） */
  groupId?: string;
  /** 账号ID */
  accountId?: string;
  timeoutMs?: number;
};

/** 更新流式卡片的返回 */
export type UpdateStreamingCardResult = {
  ok: boolean;
  error?: string;
};

/** 流式卡片会话，用于管理整个流式过程 */
export type StreamingCardSession = {
  modifyToken: string;
  receiverId: string;
  receiverType: "user" | "group";
  account: ResolvedInfoflowAccount;
  cfg: OpenClawConfig;
  /** 当前累积的文本内容 */
  currentText: string;
  /** 是否已结束 */
  finalized: boolean;
};

// ---------------------------------------------------------------------------
// API Implementation
// ---------------------------------------------------------------------------

/**
 * 创建流式卡片
 * 发送初始卡片，返回 modify_token 用于后续更新
 */
export async function createStreamingCard(
  params: CreateStreamingCardParams,
): Promise<CreateStreamingCardResult> {
  const {
    cfg,
    receiverId,
    receiverType,
    initialContent,
    offlineNotifyText = "正在思考中...",
    appContext,
    accountId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const { apiHost, appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // 获取 token
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:streamingCard] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const clientMsgId = Date.now();

    // 构建初始内容
    const contents: StreamingCardContents = {
      card_init: { type: "text", content: "1" },
    };

    // 如果有初始文本，添加到 ai_markdown
    if (initialContent) {
      contents.ai_markdown = { type: "text", content: initialContent };
    }

    const payload = {
      contents,
      meta: {
        client_msg_id: clientMsgId,
        client_send_time: clientMsgId,
        interactivity_expire: 7776000, // 90天
        interactivity_mode: "normal",
        modify_expire: 7776000,
        offline_notify_txt: offlineNotifyText,
        app_context: appContext ?? {},
        template: {
          name: "streaming_render",
          version: 30,
        },
      },
      type: 1,
      content_id: String(clientMsgId),
      receiver_id: receiverId,
      receiver_type: receiverType,
      scene: "IM-server",
      user_msg: false,
    };

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json; charset=utf-8",
    };

    const bodyStr = JSON.stringify(payload);
    logVerbose(`[infoflow:streamingCard:create] POST body: ${bodyStr}`);

    const res = await fetch(`${ensureHttps(apiHost)}${STREAMING_CARD_CREATE_PATH}`, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    const responseText = await res.text();
    const data = JSON.parse(responseText) as Record<string, unknown>;
    logVerbose(`[infoflow:streamingCard:create] response: status=${res.status}, data=${responseText}`);

    // 检查响应
    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:streamingCard:create] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    // 提取 modify_token 和 messageId
    // API 响应结构:
    // { code: "ok", data: { receivers: [{ modify_token: "...", msg_id: ..., card_id: ... }] } }
    const innerData = data.data as Record<string, unknown> | undefined;
    const receivers = innerData?.receivers as Array<Record<string, unknown>> | undefined;
    const firstReceiver = receivers?.[0];
    
    logVerbose(`[infoflow:streamingCard:create] receivers count: ${receivers?.length ?? 0}`);
    if (firstReceiver) {
      logVerbose(`[infoflow:streamingCard:create] firstReceiver keys: ${Object.keys(firstReceiver).join(", ")}`);
    }
    
    // 从 receivers[0] 获取 modify_token
    const modifyToken = firstReceiver?.modify_token as string | undefined;
    const messageId = String(firstReceiver?.msg_id ?? firstReceiver?.messageid ?? "");
    const cardId = String(firstReceiver?.card_id ?? "");

    if (!modifyToken) {
      getInfoflowSendLog().error(`[infoflow:streamingCard:create] no modify_token in response. Full response: ${responseText}`);
      return { ok: false, error: "no modify_token in response" };
    }

    logVerbose(`[infoflow:streamingCard:create] success: modifyToken=${modifyToken}, messageId=${messageId}, cardId=${cardId}`);

    return { ok: true, modifyToken, messageId };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:streamingCard:create] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 更新流式卡片内容
 */
export async function updateStreamingCard(
  params: UpdateStreamingCardParams,
): Promise<UpdateStreamingCardResult> {
  const {
    cfg,
    modifyToken,
    receiverType,
    contents,
    userIds,
    groupId,
    accountId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  const account = resolveInfoflowAccount({ cfg, accountId });
  const { apiHost, appKey, appSecret } = account.config;

  if (!appKey || !appSecret) {
    return { ok: false, error: "Infoflow appKey/appSecret not configured." };
  }

  // 获取 token
  const tokenResult = await getAppAccessToken({ apiHost, appKey, appSecret, timeoutMs });
  if (!tokenResult.ok || !tokenResult.token) {
    getInfoflowSendLog().error(`[infoflow:streamingCard:update] token error: ${tokenResult.error}`);
    return { ok: false, error: tokenResult.error ?? "failed to get token" };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
      Authorization: `Bearer-${tokenResult.token}`,
      "Content-Type": "application/json; charset=utf-8",
    };

    let payload: Record<string, unknown>;
    let apiPath: string;

    if (receiverType === "user") {
      // 单人视角更新
      apiPath = STREAMING_CARD_UPDATE_PERSONAL_PATH;
      payload = {
        modify_token: modifyToken,
        new_personal_msg_content: [
          {
            user_ids: userIds ?? [],
            personal_msg_content: contents,
            notify_msg_content: null,
          },
        ],
      };
    } else {
      // 群聊视角更新
      // notify_list 告知服务端通知哪个群（to_type: 2=群聊）
      apiPath = STREAMING_CARD_UPDATE_GROUP_PATH;
      payload = {
        modify_token: modifyToken,
        new_dynamic_msg_content: contents,
        // version 由业务方自维护，使用时间戳确保单调递增（文档说明：可设置为时间戳）
        version: Date.now(),
        notify_list: groupId
          ? [{ to_type: 2, to_ids: [Number(groupId)] }]
          : [],
      };
    }

    const bodyStr = JSON.stringify(payload);
    logVerbose(`[infoflow:streamingCard:update] POST ${apiPath} body: ${bodyStr}`);

    const res = await fetch(`${ensureHttps(apiHost)}${apiPath}`, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    const responseText = await res.text();
    const data = JSON.parse(responseText) as Record<string, unknown>;
    logVerbose(`[infoflow:streamingCard:update] response: status=${res.status}, data=${responseText}`);

    const code = typeof data.code === "string" ? data.code : "";
    if (code !== "ok") {
      const errMsg = String(data.message ?? data.errmsg ?? `code=${code || "unknown"}`);
      getInfoflowSendLog().error(`[infoflow:streamingCard:update] failed: ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    return { ok: true };
  } catch (err) {
    const errMsg = formatInfoflowError(err);
    getInfoflowSendLog().error(`[infoflow:streamingCard:update] exception: ${errMsg}`);
    return { ok: false, error: errMsg };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Streaming Session Management
// ---------------------------------------------------------------------------

/**
 * 开始一个新的流式卡片会话
 */
export async function startStreamingSession(params: {
  cfg: OpenClawConfig;
  receiverId: string;
  receiverType: "user" | "group";
  accountId?: string;
}): Promise<{ ok: boolean; session?: StreamingCardSession; error?: string }> {
  const { cfg, receiverId, receiverType, accountId } = params;

  const account = resolveInfoflowAccount({ cfg, accountId });

  const result = await createStreamingCard({
    cfg,
    receiverId,
    receiverType,
    accountId,
    offlineNotifyText: "正在思考中...",
  });

  if (!result.ok || !result.modifyToken) {
    return { ok: false, error: result.error ?? "failed to create streaming card" };
  }

  const session: StreamingCardSession = {
    modifyToken: result.modifyToken,
    receiverId,
    receiverType,
    account,
    cfg,
    currentText: "",
    finalized: false,
  };

  return { ok: true, session };
}

/**
 * 追加文本到流式会话
 */
export async function appendToStreamingSession(
  session: StreamingCardSession,
  text: string,
): Promise<UpdateStreamingCardResult> {
  if (session.finalized) {
    return { ok: false, error: "session already finalized" };
  }

  session.currentText += text;

  const contents: StreamingCardContents = {
    card_init: { type: "text", content: "1" },
    ai_markdown: { type: "text", content: session.currentText },
  };

  return updateStreamingCard({
    cfg: session.cfg,
    modifyToken: session.modifyToken,
    receiverType: session.receiverType,
    contents,
    userIds: session.receiverType === "user" ? [session.receiverId] : undefined,
    groupId: session.receiverType === "group" ? session.receiverId : undefined,
    accountId: session.account.accountId,
  });
}

/**
 * 结束流式会话
 */
export async function finalizeStreamingSession(
  session: StreamingCardSession,
  finalText?: string,
): Promise<UpdateStreamingCardResult> {
  if (session.finalized) {
    return { ok: false, error: "session already finalized" };
  }

  if (finalText) {
    session.currentText = finalText;
  }

  const contents: StreamingCardContents = {
    card_init: { type: "text", content: "1" },
    ai_markdown: { type: "text", content: session.currentText },
    // 结束标记
    dc_print_end: { type: "text", content: "1" },
    // 思考完成状态
    think_star_img: { type: "text", content: "ast/think_star_static.png" },
    think_status_img: { type: "text", content: "ast/thinking_yes.png" },
    think_status_color: { type: "text", content: "#5C6473" },
    think_status_text: { type: "text", content: "思考完成" },
    think_layout_install: { type: "text", content: "0" },
  };

  const result = await updateStreamingCard({
    cfg: session.cfg,
    modifyToken: session.modifyToken,
    receiverType: session.receiverType,
    contents,
    userIds: session.receiverType === "user" ? [session.receiverId] : undefined,
    groupId: session.receiverType === "group" ? session.receiverId : undefined,
    accountId: session.account.accountId,
  });

  if (result.ok) {
    session.finalized = true;
  }

  return result;
}

/**
 * 更新状态信息（如"使用【XX插件】..."）
 */
export async function updateStreamingStatus(
  session: StreamingCardSession,
  statusText: string,
): Promise<UpdateStreamingCardResult> {
  if (session.finalized) {
    return { ok: false, error: "session already finalized" };
  }

  const contents: StreamingCardContents = {
    card_init: { type: "text", content: "1" },
    status_info: { type: "text", content: statusText },
    ai_markdown: { type: "text", content: session.currentText },
  };

  return updateStreamingCard({
    cfg: session.cfg,
    modifyToken: session.modifyToken,
    receiverType: session.receiverType,
    contents,
    userIds: session.receiverType === "user" ? [session.receiverId] : undefined,
    groupId: session.receiverType === "group" ? session.receiverId : undefined,
    accountId: session.account.accountId,
  });
}
