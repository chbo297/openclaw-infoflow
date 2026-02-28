import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
    channel: {
      text: {
        chunkText: (text: string, limit: number) => {
          // Simple chunking for tests
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length ? chunks : [text];
        },
      },
    },
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  createReplyPrefixOptions: vi.fn(() => ({
    onModelSelected: vi.fn(),
    responsePrefix: undefined,
  })),
}));

const mockSendInfoflowMessage = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendInfoflowMessage: mockSendInfoflowMessage,
}));

import { createInfoflowReplyDispatcher } from "./reply-dispatcher.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInfoflowReplyDispatcher", () => {
  beforeEach(() => {
    mockSendInfoflowMessage.mockReset();
    mockSendInfoflowMessage.mockResolvedValue({ ok: true, messageId: "msg-1" });
  });

  it("returns dispatcherOptions with deliver and onError", () => {
    const result = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
    });

    expect(result.dispatcherOptions).toBeDefined();
    expect(typeof result.dispatcherOptions.deliver).toBe("function");
    expect(typeof result.dispatcherOptions.onError).toBe("function");
    expect(result.replyOptions).toBeDefined();
  });

  it("deliver sends message via sendInfoflowMessage", async () => {
    const statusSink = vi.fn();
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
      statusSink,
    });

    await dispatcherOptions.deliver({ text: "Hello world" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello world" }],
      accountId: "acc-1",
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });

  it("deliver skips empty text", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
    });

    await dispatcherOptions.deliver({ text: "" });
    await dispatcherOptions.deliver({ text: "   " });

    expect(mockSendInfoflowMessage).not.toHaveBeenCalled();
  });

  it("deliver adds AT content for group messages (first chunk only)", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:12345",
      atOptions: { atUserIds: ["user1", "user2"] },
    });

    await dispatcherOptions.deliver({ text: "Hello" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:12345",
      contents: [
        { type: "at", content: "user1,user2" },
        { type: "markdown", content: "@user1 @user2 Hello" },
      ],
      accountId: "acc-1",
    });

    // Test atAll variant
    mockSendInfoflowMessage.mockClear();
    const { dispatcherOptions: opts2 } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:99999",
      atOptions: { atAll: true },
    });

    await opts2.deliver({ text: "Announcement" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:99999",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Announcement" },
      ],
      accountId: "acc-1",
    });
  });

  it("deliver resolves @userid from LLM output and adds AT content", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:12345",
      mentionIds: { userIds: ["alice01"], agentIds: [] },
    });

    await dispatcherOptions.deliver({ text: "Hey @alice01 check this" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:12345",
      contents: [
        { type: "at", content: "alice01" },
        { type: "markdown", content: "Hey @alice01 check this" },
      ],
      accountId: "acc-1",
    });
  });

  it("deliver resolves @agentid from LLM output and adds at-agent content", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:12345",
      mentionIds: { userIds: [], agentIds: [1282] },
    });

    await dispatcherOptions.deliver({ text: "Pinging @1282" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:12345",
      contents: [
        { type: "at-agent", content: "1282" },
        { type: "markdown", content: "Pinging @1282" },
      ],
      accountId: "acc-1",
    });
  });

  it("deliver merges atOptions userIds with LLM-resolved userIds", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "group:12345",
      atOptions: { atUserIds: ["sender01"] },
      mentionIds: { userIds: ["alice01"], agentIds: [1282] },
    });

    await dispatcherOptions.deliver({ text: "Hey @alice01 and @1282" });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:12345",
      contents: [
        { type: "at", content: "sender01,alice01" },
        { type: "at-agent", content: "1282" },
        { type: "markdown", content: "@sender01 Hey @alice01 and @1282" },
      ],
      accountId: "acc-1",
    });
  });

  it("deliver sends private message without AT prefix or mention resolution", async () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "chengbo05",
      mentionIds: { userIds: ["alice01"], agentIds: [] },
    });

    await dispatcherOptions.deliver({ text: "Hello @alice01" });

    // Private messages should not resolve mentions or add AT content
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "chengbo05",
      contents: [{ type: "markdown", content: "Hello @alice01" }],
      accountId: "acc-1",
    });
  });

  it("onError logs error via send logger", () => {
    const { dispatcherOptions } = createInfoflowReplyDispatcher({
      cfg: {} as never,
      agentId: "agent-1",
      accountId: "acc-1",
      to: "user1",
    });

    // onError should not throw
    expect(() => dispatcherOptions.onError(new Error("test error"))).not.toThrow();
  });
});
