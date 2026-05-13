import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
    },
  })),
}));

import {
  _resetInboundContext,
  _inboundContextSize,
  lookupInboundContext,
  registerInboundContext,
} from "./inbound-context.js";

describe("inbound-context", () => {
  beforeEach(() => {
    _resetInboundContext();
  });

  it("registers and looks up by inboundMessageId", () => {
    registerInboundContext({
      accountId: "a",
      target: "group:1",
      inboundMessageId: "MID-1",
      replyToMessageId: "BOT-1",
      registeredAt: Date.now(),
    });
    const out = lookupInboundContext("MID-1");
    expect(out?.replyToMessageId).toBe("BOT-1");
    expect(out?.target).toBe("group:1");
  });

  it("returns undefined for unknown inbound id", () => {
    expect(lookupInboundContext("nope")).toBeUndefined();
  });

  it("evicts entries older than retention window on next register", () => {
    registerInboundContext({
      accountId: "a",
      target: "group:1",
      inboundMessageId: "OLD",
      registeredAt: Date.now() - 60 * 60 * 1000, // 1h ago — past 10m TTL
    });
    expect(_inboundContextSize()).toBe(1);
    // Trigger evictExpired via a second register
    registerInboundContext({
      accountId: "a",
      target: "group:1",
      inboundMessageId: "NEW",
      registeredAt: Date.now(),
    });
    expect(lookupInboundContext("OLD")).toBeUndefined();
    expect(lookupInboundContext("NEW")).toBeDefined();
  });

  it("lookup also returns undefined when entry is past TTL", () => {
    registerInboundContext({
      accountId: "a",
      target: "group:1",
      inboundMessageId: "STALE",
      registeredAt: Date.now() - 60 * 60 * 1000,
    });
    expect(lookupInboundContext("STALE")).toBeUndefined();
  });

  it("preserves replyTargets array as registered", () => {
    registerInboundContext({
      accountId: "a",
      target: "group:1",
      inboundMessageId: "MID",
      replyTargets: [
        { messageid: "1", preview: "a", isBotMessage: false },
        { messageid: "2", preview: "b", isBotMessage: true },
      ],
      registeredAt: Date.now(),
    });
    const out = lookupInboundContext("MID");
    expect(out?.replyTargets).toHaveLength(2);
    expect(out?.replyTargets?.[1].isBotMessage).toBe(true);
  });
});
