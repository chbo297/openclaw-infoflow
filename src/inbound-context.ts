/**
 * In-memory registry of inbound message context, used by the delete action handler
 * to recover when the LLM passes a wrong messageId.
 *
 * Why: openclaw's ChannelMessageActionContext exposes the inbound trigger's
 * currentMessageId (via ctx.toolContext) but does NOT carry the inbound's
 * replyToMessageId / resolved reply targets. We register that context here on
 * inbound, keyed by the inbound messageId, and consume it from the action
 * handler.
 *
 * Entries auto-expire after RETENTION_MS to keep the map bounded.
 */

import { logVerbose } from "./logging.js";

const RETENTION_MS = 10 * 60 * 1000; // 10 minutes — same order of magnitude as followUp window
const MAX_ENTRIES = 500;

export type InboundContextRecord = {
  accountId: string;
  target: string;
  /** Inbound messageId (the user-sent message currently being processed). */
  inboundMessageId: string;
  /** messageId of the bot message that the inbound is quote-replying to, if any. */
  replyToMessageId?: string;
  /** All quoted-reply targets resolved from inbound replyData items. */
  replyTargets?: ReadonlyArray<{
    messageid: string;
    preview: string;
    isBotMessage: boolean;
  }>;
  registeredAt: number;
};

const store = new Map<string, InboundContextRecord>();

function evictExpired(): void {
  if (store.size === 0) return;
  const cutoff = Date.now() - RETENTION_MS;
  let count = 0;
  for (const [key, entry] of store) {
    if (entry.registeredAt < cutoff) {
      store.delete(key);
      count++;
    }
  }
  if (count > 0) {
    logVerbose(`[infoflow:inbound-ctx] evicted ${count} expired entries`);
  }
}

export function registerInboundContext(record: InboundContextRecord): void {
  evictExpired();
  // Cap the map size; if we're over, drop the oldest entries.
  if (store.size >= MAX_ENTRIES) {
    const sorted = Array.from(store.entries()).sort(
      (a, b) => a[1].registeredAt - b[1].registeredAt,
    );
    const dropCount = store.size - MAX_ENTRIES + 1;
    for (let i = 0; i < dropCount; i++) {
      store.delete(sorted[i][0]);
    }
  }
  store.set(record.inboundMessageId, record);
}

export function lookupInboundContext(inboundMessageId: string): InboundContextRecord | undefined {
  const entry = store.get(inboundMessageId);
  if (!entry) return undefined;
  if (Date.now() - entry.registeredAt > RETENTION_MS) {
    store.delete(inboundMessageId);
    return undefined;
  }
  return entry;
}

/** @internal — for tests */
export function _resetInboundContext(): void {
  store.clear();
}

/** @internal — for tests */
export function _inboundContextSize(): number {
  return store.size;
}
