import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import {
  getChannelSection,
  listInfoflowAccountIds,
  resolveDefaultInfoflowAccountId,
  resolveInfoflowAccount,
} from "./accounts.js";
import { infoflowMessageActions } from "./actions.js";
import { createListSentMessagesTool } from "./agent-tools.js";
import { logVerbose } from "./logging.js";
import { parseMarkdownForLocalImages } from "./markdown-local-images.js";
import { prepareInfoflowImageBase64, sendInfoflowImageMessage } from "./media.js";
import { startInfoflowMonitor, startInfoflowWSMonitor } from "./monitor.js";
import { getInfoflowRuntime } from "./runtime.js";
import { sendInfoflowMessage } from "./send.js";
import { normalizeInfoflowTarget, looksLikeInfoflowId } from "./targets.js";
import type { InfoflowOutboundReply, ResolvedInfoflowAccount } from "./types.js";

// Re-export types and account functions for external consumers
export type {
  InfoflowAccountConfig,
  InfoflowConnectionMode,
  ResolvedInfoflowAccount,
} from "./types.js";
export { resolveInfoflowAccount } from "./accounts.js";

// ---------------------------------------------------------------------------
// Channel plugin
// ---------------------------------------------------------------------------

function applyInfoflowSetupPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, accountId, patch } = params;
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const existingInfoflow = (channels["infoflow"] ?? {}) as Record<string, unknown>;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...channels,
        infoflow: {
          ...existingInfoflow,
          enabled: true,
          ...patch,
        },
      },
    };
  }

  const existingAccounts = (existingInfoflow.accounts ?? {}) as Record<string, Record<string, unknown>>;
  return {
    ...cfg,
    channels: {
      ...channels,
      infoflow: {
        ...existingInfoflow,
        enabled: true,
        accounts: {
          ...existingAccounts,
          [accountId]: {
            ...existingAccounts[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

export const infoflowPlugin: ChannelPlugin<ResolvedInfoflowAccount> = {
  id: "infoflow",
  meta: {
    id: "infoflow",
    label: "Infoflow",
    selectionLabel: "Infoflow (如流)",
    docsPath: "/channels/infoflow",
    blurb: "Baidu Infoflow enterprise messaging platform.",
    showConfigured: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    nativeCommands: true,
    unsend: true,
  },
  reload: { configPrefixes: ["channels.infoflow"] },
  actions: infoflowMessageActions,
  agentTools: (params) => [
    createListSentMessagesTool({
      getConfig: () => params.cfg ?? ({} as OpenClawConfig),
    }),
  ],
  agentPrompt: {
    messageToolHints: () => [
      'Infoflow group @mentions: set atAll=true to @all members, or mentionUserIds="user1,user2" (comma-separated uuapName) to @mention specific users. Only effective for group targets (group:<id>).',
      'Infoflow message recall (撤回): use action="delete" to recall a bot-sent message.',
      '  - To recall a specific message, pass messageId=<the bot message id>. Get the id from (a) the "Recent messages you (the bot) sent" section that may be injected into the body, (b) the "quoted reply target" block when sentByBot=true, or (c) the infoflow_list_sent_messages tool.',
      '  - To recall the most recent message without specifying id, omit messageId (defaults to count=1).',
      '  - For batch recall use count=<N>.',
      '  - NEVER pass the current inbound message_id (the user-sent message you are replying to) as the delete target — that is the USER\'s message, not a bot message; the call will fail.',
      '  - When a quoted reply target is present with sentByBot=true, that messageId is the most likely recall target.',
      '  - For messages older than the injected recent window, or hard-to-identify ones, call infoflow_list_sent_messages first (use containsText / withinHours filters) and then pass the chosen messageId to action="delete".',
    ],
  },
  config: {
    listAccountIds: (cfg) => listInfoflowAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveInfoflowAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultInfoflowAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "infoflow",
        accountId,
        clearBaseFields: ["checkToken", "encodingAESKey", "appKey", "appSecret", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelCfg = getChannelSection(cfg);
      const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.infoflow.accounts.${resolvedAccountId}.`
        : "channels.infoflow.";

      return {
        policy: ((account.config as Record<string, unknown>).dmPolicy as string) ?? "open",
        allowFrom: ((account.config as Record<string, unknown>).allowFrom as string[]) ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("infoflow"),
        normalizeEntry: (raw: string) => raw.replace(/^infoflow:/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        ((account.config as Record<string, unknown>).groupPolicy as string) ??
        defaultGroupPolicy ??
        "open";

      if (groupPolicy === "open") {
        warnings.push(
          `- Infoflow groups: groupPolicy="open" allows any group to trigger. Consider setting channels.infoflow.groupPolicy="allowlist".`,
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const channelCfg = getChannelSection(cfg);
      const accountCfg =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? channelCfg?.accounts?.[accountId]
          : channelCfg;
      return (accountCfg as Record<string, unknown> | undefined)?.requireMention !== false;
    },
    resolveToolPolicy: () => {
      // Return undefined to use global policy
      return undefined;
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeInfoflowTarget(raw),
    targetResolver: {
      looksLikeId: looksLikeInfoflowId,
      hint: "<username|group:groupId>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token) {
        return "Infoflow requires --token (checkToken).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "infoflow",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "infoflow" })
          : namedConfig;

      const patch: Record<string, unknown> = {};
      if (input.token) {
        patch.checkToken = input.token;
      }
      return applyInfoflowSetupPatch({ cfg: next, accountId, patch });
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 2048,
    chunker: (text, limit) => getInfoflowRuntime().channel.text.chunkText(text, limit),
    sendText: async ({ cfg, to, text, accountId, mediaLocalRoots, replyToId }) => {
      logVerbose(`[infoflow:sendText] to=${to}, accountId=${accountId}`);
      const isGroup = /^group:\d+$/i.test(to.replace(/^infoflow:/i, ""));
      const replyTo: InfoflowOutboundReply | undefined =
        isGroup && replyToId?.trim() ? { messageid: replyToId.trim(), preview: "" } : undefined;

      const segments = parseMarkdownForLocalImages(text);
      let replyApplied = false;
      const sendPromises: Promise<{ ok?: boolean; messageId?: string }>[] = [];

      for (const segment of segments) {
        if (segment.type === "text") {
          const content = segment.content.trim();
          if (!content) continue;
          sendPromises.push(
            sendInfoflowMessage({
              cfg,
              to,
              contents: [{ type: "markdown", content: segment.content }],
              accountId: accountId ?? undefined,
              replyTo: replyApplied ? undefined : replyTo,
            }),
          );
          replyApplied = true;
          continue;
        }
        // segment.type === "image"
        try {
          const prepared = await prepareInfoflowImageBase64({
            mediaUrl: segment.content,
            mediaLocalRoots: mediaLocalRoots ?? undefined,
          });
          if (prepared.isImage) {
            sendPromises.push(
              sendInfoflowImageMessage({
                cfg,
                to,
                base64Image: prepared.base64,
                accountId: accountId ?? undefined,
                replyTo: replyApplied ? undefined : replyTo,
              }),
            );
            replyApplied = true;
          } else {
            sendPromises.push(
              sendInfoflowMessage({
                cfg,
                to,
                contents: [{ type: "link", content: segment.content }],
                accountId: accountId ?? undefined,
                replyTo: replyApplied ? undefined : replyTo,
              }),
            );
            replyApplied = true;
          }
        } catch (err) {
          logVerbose(`[infoflow:sendText] image prep failed, sending as link: ${err}`);
          sendPromises.push(
            sendInfoflowMessage({
              cfg,
              to,
              contents: [{ type: "link", content: segment.content }],
              accountId: accountId ?? undefined,
              replyTo: replyApplied ? undefined : replyTo,
            }),
          );
          replyApplied = true;
        }
      }

      if (sendPromises.length === 0) {
        return { channel: "infoflow", messageId: "failed" };
      }
      const results = await Promise.all(sendPromises);
      const lastOk = results.filter((r) => r?.ok).at(-1);
      return {
        channel: "infoflow",
        messageId: lastOk ? (lastOk.messageId ?? "sent") : "failed",
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, mediaLocalRoots }) => {
      logVerbose(`[infoflow:sendMedia] to=${to}, accountId=${accountId}, mediaUrl=${mediaUrl}`);

      const trimmedText = text?.trim();

      // Helper: send text as markdown
      const sendText = () =>
        sendInfoflowMessage({
          cfg,
          to,
          contents: [{ type: "markdown", content: trimmedText! }],
          accountId: accountId ?? undefined,
        });

      // Helper: attempt native image send, fall back to link
      const sendImage = async (): Promise<{ ok: boolean; messageId?: string }> => {
        if (!mediaUrl) return { ok: false };
        try {
          const prepared = await prepareInfoflowImageBase64({
            mediaUrl,
            mediaLocalRoots: mediaLocalRoots ?? undefined,
          });
          if (prepared.isImage) {
            const result = await sendInfoflowImageMessage({
              cfg,
              to,
              base64Image: prepared.base64,
              accountId: accountId ?? undefined,
            });
            if (result.ok) return { ok: true, messageId: result.messageId };
            // Native send failed, fall back to link
            logVerbose(
              `[infoflow:sendMedia] native image failed: ${result.error}, falling back to link`,
            );
          }
        } catch (err) {
          logVerbose(`[infoflow:sendMedia] image prep failed, falling back to link: ${err}`);
        }
        // Fallback: send as link
        const linkResult = await sendInfoflowMessage({
          cfg,
          to,
          contents: [{ type: "link", content: mediaUrl }],
          accountId: accountId ?? undefined,
        });
        return { ok: linkResult.ok, messageId: linkResult.messageId };
      };

      // b-mode: fire in upstream order (caption first, then media), then await all
      if (trimmedText && mediaUrl) {
        const p1 = sendText();
        const p2 = sendImage();
        const [, imageResult] = await Promise.all([p1, p2]);
        return {
          channel: "infoflow",
          messageId: imageResult.ok ? (imageResult.messageId ?? "sent") : "failed",
        };
      }
      if (trimmedText) {
        const result = await sendText();
        return {
          channel: "infoflow",
          messageId: result.ok ? (result.messageId ?? "sent") : "failed",
        };
      }
      if (mediaUrl) {
        const result = await sendImage();
        return {
          channel: "infoflow",
          messageId: result.ok ? (result.messageId ?? "sent") : "failed",
        };
      }

      return { channel: "infoflow", messageId: "failed" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const connectionMode = account.config.connectionMode ?? "webhook";
      ctx.log?.info(`[${account.accountId}] starting Infoflow (${connectionMode})`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });
      const monitorOptions = {
        account,
        config: ctx.cfg,
        abortSignal: ctx.abortSignal,
        statusSink: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) =>
          ctx.setStatus({ accountId: account.accountId, ...patch }),
      };
      const unregister =
        connectionMode === "websocket"
          ? await startInfoflowWSMonitor(monitorOptions)
          : await startInfoflowMonitor(monitorOptions);

      // Keep the channel alive until explicitly stopped.
      // Without this, the promise resolves immediately and the gateway
      // framework treats it as "channel exited", triggering auto-restart.
      try {
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      }
    },
  },
};
