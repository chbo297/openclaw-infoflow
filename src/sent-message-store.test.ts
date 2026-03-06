import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Each test gets a unique temp dir to avoid cross-test DB contamination
let testDir = "";
let testCounter = 0;

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    state: {
      resolveStateDir: () => testDir,
    },
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
    },
  })),
}));

import {
  recordSentMessage,
  querySentMessages,
  findSentMessage,
  removeRecalledMessages,
  buildMessageDigest,
  buildAgentFrom,
  _resetStore,
} from "./sent-message-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT = "test-account";
const ACCOUNT_B = "other-account";
const TARGET_GROUP = "group:12345";
const TARGET_DM = "chengbo05";

function makeRecord(
  overrides: Partial<Parameters<typeof recordSentMessage>[1]> = {},
): Parameters<typeof recordSentMessage>[1] {
  return {
    target: TARGET_GROUP,
    from: "agent:12345",
    messageid: String(Date.now() + Math.random()),
    msgseqid: String(Math.floor(Math.random() * 999999)),
    digest: "hello world",
    sentAt: Date.now(),
    ...overrides,
  } as Parameters<typeof recordSentMessage>[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sent-message-store", () => {
  beforeEach(() => {
    _resetStore();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-store-test-${testCounter++}-`));
  });

  afterEach(() => {
    _resetStore();
    // Clean up temp dir
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // recordSentMessage + querySentMessages
  // -------------------------------------------------------------------------

  it("records and queries messages by target", () => {
    const now = Date.now();
    const r1 = makeRecord({ messageid: "msg-1", sentAt: now - 2000 });
    const r2 = makeRecord({ messageid: "msg-2", sentAt: now - 1000 });
    const r3 = makeRecord({ messageid: "msg-3", sentAt: now, target: TARGET_DM });

    recordSentMessage(ACCOUNT, r1);
    recordSentMessage(ACCOUNT, r2);
    recordSentMessage(ACCOUNT, r3);

    const groupMsgs = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(groupMsgs).toHaveLength(2);
    // Ordered by sent_at DESC
    expect(groupMsgs[0].messageid).toBe("msg-2");
    expect(groupMsgs[1].messageid).toBe("msg-1");

    const dmMsgs = querySentMessages(ACCOUNT, { target: TARGET_DM, count: 10 });
    expect(dmMsgs).toHaveLength(1);
    expect(dmMsgs[0].messageid).toBe("msg-3");
  });

  it("respects count limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      recordSentMessage(ACCOUNT, makeRecord({ messageid: `msg-${i}`, sentAt: now + i * 1000 }));
    }

    const msgs = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 3 });
    expect(msgs).toHaveLength(3);
    // Most recent first
    expect(msgs[0].messageid).toBe("msg-4");
  });

  // -------------------------------------------------------------------------
  // findSentMessage
  // -------------------------------------------------------------------------

  it("finds a message by messageid", () => {
    const record = makeRecord({ messageid: "find-me", msgseqid: "seq-99", digest: "test" });
    recordSentMessage(ACCOUNT, record);

    const found = findSentMessage(ACCOUNT, "find-me");
    expect(found).toBeDefined();
    expect(found!.messageid).toBe("find-me");
    expect(found!.msgseqid).toBe("seq-99");
    expect(found!.digest).toBe("test");
  });

  it("returns undefined for non-existent messageid", () => {
    const found = findSentMessage(ACCOUNT, "does-not-exist");
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // removeRecalledMessages
  // -------------------------------------------------------------------------

  it("removes recalled messages by messageid", () => {
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "rm-1" }));
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "rm-2" }));
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "rm-3" }));

    removeRecalledMessages(ACCOUNT, ["rm-1", "rm-3"]);

    const remaining = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].messageid).toBe("rm-2");
  });

  it("does nothing for empty messageids array", () => {
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "keep-me" }));
    removeRecalledMessages(ACCOUNT, []);

    const remaining = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(remaining).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Multi-account isolation
  // -------------------------------------------------------------------------

  it("isolates records by account_id", () => {
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "a-msg" }));
    recordSentMessage(ACCOUNT_B, makeRecord({ messageid: "b-msg" }));

    const aMsgs = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(aMsgs).toHaveLength(1);
    expect(aMsgs[0].messageid).toBe("a-msg");

    const bMsgs = querySentMessages(ACCOUNT_B, { target: TARGET_GROUP, count: 10 });
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0].messageid).toBe("b-msg");
  });

  it("findSentMessage is account-scoped", () => {
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "shared-id" }));
    expect(findSentMessage(ACCOUNT, "shared-id")).toBeDefined();
    expect(findSentMessage(ACCOUNT_B, "shared-id")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Auto-cleanup (7 days)
  // -------------------------------------------------------------------------

  it("auto-cleans records older than 7 days on insert", () => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000;
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "old-msg", sentAt: sevenDaysAgo }));

    // New insert triggers cleanup
    recordSentMessage(ACCOUNT, makeRecord({ messageid: "new-msg", sentAt: Date.now() }));

    const msgs = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageid).toBe("new-msg");
  });

  // -------------------------------------------------------------------------
  // from field
  // -------------------------------------------------------------------------

  it("stores and retrieves the from field", () => {
    const record = makeRecord({ messageid: "from-test", from: "agent:999" });
    recordSentMessage(ACCOUNT, record);

    const found = findSentMessage(ACCOUNT, "from-test");
    expect(found).toBeDefined();
    expect(found!.from).toBe("agent:999");

    const queried = querySentMessages(ACCOUNT, { target: TARGET_GROUP, count: 10 });
    expect(queried[0].from).toBe("agent:999");
  });

  it("defaults from to empty string for records without from", () => {
    const record = makeRecord({ messageid: "no-from", from: "" });
    recordSentMessage(ACCOUNT, record);

    const found = findSentMessage(ACCOUNT, "no-from");
    expect(found).toBeDefined();
    expect(found!.from).toBe("");
  });
});

// ===========================================================================
// buildAgentFrom
// ===========================================================================

describe("buildAgentFrom", () => {
  it("returns agent:<id> when appAgentId is provided", () => {
    expect(buildAgentFrom(12345)).toBe("agent:12345");
  });

  it("returns agent:unknown when appAgentId is undefined", () => {
    expect(buildAgentFrom(undefined)).toBe("agent:unknown");
  });
});

// ===========================================================================
// buildMessageDigest
// ===========================================================================

describe("buildMessageDigest", () => {
  it("truncates text content at 100 chars", () => {
    const longText = "A".repeat(120);
    const digest = buildMessageDigest([{ type: "text", content: longText }]);
    expect(digest).toBe("A".repeat(100) + "…");
  });

  it("returns full text when <= 100 chars", () => {
    const digest = buildMessageDigest([{ type: "markdown", content: "Short msg" }]);
    expect(digest).toBe("Short msg");
  });

  it("returns 'image' for image-only content", () => {
    const digest = buildMessageDigest([{ type: "image", content: "base64data" }]);
    expect(digest).toBe("image");
  });

  it("returns link content for link items", () => {
    const digest = buildMessageDigest([{ type: "link", content: "[Docs]https://example.com" }]);
    expect(digest).toBe("[Docs]https://example.com");
  });

  it("returns empty string for empty contents", () => {
    const digest = buildMessageDigest([]);
    expect(digest).toBe("");
  });

  it("combines text and link content", () => {
    const digest = buildMessageDigest([
      { type: "text", content: "Visit:" },
      { type: "link", content: "https://example.com" },
    ]);
    expect(digest).toBe("Visit: https://example.com");
  });

  it("prefers text over image in mixed content", () => {
    const digest = buildMessageDigest([
      { type: "text", content: "See image" },
      { type: "image", content: "base64data" },
    ]);
    expect(digest).toBe("See image");
  });

  it("returns 'image' for at-only + image content", () => {
    const digest = buildMessageDigest([
      { type: "at", content: "all" },
      { type: "image", content: "base64data" },
    ]);
    expect(digest).toBe("image");
  });
});
