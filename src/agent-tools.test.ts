import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuerySentMessages = vi.hoisted(() => vi.fn());
vi.mock("./sent-message-store.js", () => ({
  querySentMessages: mockQuerySentMessages,
}));

vi.mock("./accounts.js", () => ({
  resolveDefaultInfoflowAccountId: vi.fn(() => "default"),
}));

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
  })),
}));

import { createListSentMessagesTool } from "./agent-tools.js";

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    target: "group:1",
    from: "agent:1",
    messageid: "msg-1",
    msgseqid: "",
    digest: "hello world",
    sentAt: Date.now(),
    ...overrides,
  };
}

describe("infoflow_list_sent_messages tool", () => {
  beforeEach(() => {
    mockQuerySentMessages.mockReset();
  });

  it("exposes name/label/description/parameters", () => {
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    expect(tool.name).toBe("infoflow_list_sent_messages");
    expect(tool.label).toBe("infoflow_list_sent_messages");
    expect(tool.description).toContain("messages the bot previously sent");
    expect(tool.parameters).toBeDefined();
  });

  it("returns messages for given target with full fields", async () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue([
      makeRecord({ messageid: "m1", digest: "first", sentAt: now - 1000 }),
      makeRecord({ messageid: "m2", digest: "second", sentAt: now - 2000 }),
    ]);
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    const result = await tool.execute("call-1", { target: "group:1" });

    const details = (result as { details: { messages: Array<{ messageId: string; sentAt: string; ageMinutes: number; preview: string }>; count: number; target: string } }).details;
    expect(details.target).toBe("group:1");
    expect(details.count).toBe(2);
    expect(details.messages).toHaveLength(2);
    expect(details.messages[0].messageId).toBe("m1");
    expect(details.messages[0].preview).toBe("first");
    expect(typeof details.messages[0].sentAt).toBe("string");
    expect(typeof details.messages[0].ageMinutes).toBe("number");
  });

  it("respects count cap (max 50)", async () => {
    mockQuerySentMessages.mockReturnValue([]);
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    await tool.execute("call-1", { target: "group:1", count: 999 });
    expect(mockQuerySentMessages).toHaveBeenCalledWith("default", { target: "group:1", count: 50 });
  });

  it("filters by withinHours", async () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue([
      makeRecord({ messageid: "fresh", sentAt: now - 1000 }),
      makeRecord({ messageid: "stale", sentAt: now - 10 * 60 * 60 * 1000 }),
    ]);
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    const result = await tool.execute("call-1", { target: "group:1", withinHours: 1 });
    const ids = (result as { details: { messages: Array<{ messageId: string }> } }).details.messages.map((m) => m.messageId);
    expect(ids).toEqual(["fresh"]);
  });

  it("filters by containsText (case-insensitive substring)", async () => {
    mockQuerySentMessages.mockReturnValue([
      makeRecord({ messageid: "joke", digest: "为什么程序员喜欢黑暗模式" }),
      makeRecord({ messageid: "weather", digest: "今天天气不错" }),
      makeRecord({ messageid: "MEETING", digest: "会议改到3点" }),
    ]);
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    const result = await tool.execute("call-1", { target: "group:1", containsText: "会议" });
    const ids = (result as { details: { messages: Array<{ messageId: string }> } }).details.messages.map((m) => m.messageId);
    expect(ids).toEqual(["MEETING"]);
  });

  it("throws when target is missing", async () => {
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    await expect(tool.execute("call-1", {} as never)).rejects.toThrow(/'target' is required/);
  });

  it("uses provided accountId override", async () => {
    mockQuerySentMessages.mockReturnValue([]);
    const tool = createListSentMessagesTool({ getConfig: () => ({}) as never });
    await tool.execute("call-1", { target: "group:1", accountId: "acct-2" });
    expect(mockQuerySentMessages).toHaveBeenCalledWith("acct-2", expect.objectContaining({}));
  });
});
