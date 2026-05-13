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
  })),
}));

vi.mock("./accounts.js", () => ({
  resolveInfoflowAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      apiHost: "https://api.infoflow.test",
      appKey: "key",
      appSecret: "secret",
      checkToken: "tok",
      encodingAESKey: "aes",
    },
  })),
}));

const mockSendInfoflowMessage = vi.hoisted(() => vi.fn());
const mockRecallInfoflowGroupMessage = vi.hoisted(() => vi.fn());
const mockRecallInfoflowPrivateMessage = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendInfoflowMessage: mockSendInfoflowMessage,
  recallInfoflowGroupMessage: mockRecallInfoflowGroupMessage,
  recallInfoflowPrivateMessage: mockRecallInfoflowPrivateMessage,
}));

const mockPrepareInfoflowImageBase64 = vi.hoisted(() => vi.fn());
const mockSendInfoflowImageMessage = vi.hoisted(() => vi.fn());
vi.mock("./media.js", () => ({
  prepareInfoflowImageBase64: mockPrepareInfoflowImageBase64,
  sendInfoflowImageMessage: mockSendInfoflowImageMessage,
}));

const mockFindSentMessage = vi.hoisted(() => vi.fn());
const mockQuerySentMessages = vi.hoisted(() => vi.fn());
const mockRemoveRecalledMessages = vi.hoisted(() => vi.fn());
vi.mock("./sent-message-store.js", () => ({
  findSentMessage: mockFindSentMessage,
  querySentMessages: mockQuerySentMessages,
  removeRecalledMessages: mockRemoveRecalledMessages,
}));

import { infoflowMessageActions } from "./actions.js";
import { registerInboundContext, _resetInboundContext } from "./inbound-context.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("infoflowMessageActions", () => {
  beforeEach(() => {
    mockSendInfoflowMessage.mockReset();
    mockSendInfoflowMessage.mockResolvedValue({ ok: true, messageId: "msg-1" });
    mockRecallInfoflowGroupMessage.mockReset();
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: true });
    mockRecallInfoflowPrivateMessage.mockReset();
    mockRecallInfoflowPrivateMessage.mockResolvedValue({ ok: true });
    mockPrepareInfoflowImageBase64.mockReset();
    mockPrepareInfoflowImageBase64.mockResolvedValue({ isImage: false }); // default: non-image
    mockSendInfoflowImageMessage.mockReset();
    mockSendInfoflowImageMessage.mockResolvedValue({ ok: true, messageId: "img-1" });
    mockFindSentMessage.mockReset();
    mockQuerySentMessages.mockReset();
    mockRemoveRecalledMessages.mockReset();
  });

  it("describeMessageTool returns send and delete", () => {
    const discovery = infoflowMessageActions.describeMessageTool?.({ cfg: {} as never });
    expect(discovery?.actions).toEqual(["send", "delete"]);
  });

  it("throws for unsupported actions", async () => {
    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "edit" as never,
        cfg: {} as never,
        params: { to: "group:123", message: "hi" },
      }),
    ).rejects.toThrow('Action "edit" is not supported for Infoflow.');
  });

  // -------------------------------------------------------------------------
  // Basic send (no mentions)
  // -------------------------------------------------------------------------

  it("sends plain text to a group without mentions", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello group" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello group" }],
      accountId: undefined,
    });
  });

  it("sends plain text to a private user", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello user" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello user" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // @all mention
  // -------------------------------------------------------------------------

  it("sends @all mention in group message (boolean)", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:456", message: "Important notice", atAll: true },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:456",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Important notice" },
      ],
      accountId: undefined,
    });
  });

  it("sends @all mention in group message (string 'true')", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:456", message: "Notice", atAll: "true" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:456",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Notice" },
      ],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // @specific users mention
  // -------------------------------------------------------------------------

  it("sends @specific users mention in group message", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:789", message: "Check this", mentionUserIds: "alice,bob" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:789",
      contents: [
        { type: "at", content: "alice,bob" },
        { type: "markdown", content: "@alice @bob Check this" },
      ],
      accountId: undefined,
    });
  });

  it("trims and filters empty mentionUserIds entries", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:789", message: "Hello", mentionUserIds: " alice , , bob " },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:789",
      contents: [
        { type: "at", content: "alice,bob" },
        { type: "markdown", content: "@alice @bob Hello" },
      ],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Private messages ignore mention params
  // -------------------------------------------------------------------------

  it("ignores atAll for private messages", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello", atAll: true },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  it("ignores mentionUserIds for private messages", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "user1", message: "Hello", mentionUserIds: "alice" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "user1",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Media URL support
  // -------------------------------------------------------------------------

  it("sends media URL as native image when image detected", async () => {
    mockPrepareInfoflowImageBase64.mockResolvedValue({ isImage: true, base64: "AQIDBA==" });

    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "See this", media: "https://example.com/image.png" },
    });

    // Text sent first
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "See this" }],
      accountId: undefined,
    });
    // Then native image
    expect(mockSendInfoflowImageMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      base64Image: "AQIDBA==",
      accountId: undefined,
    });
  });

  it("falls back to link for non-image media", async () => {
    // Default mock returns { isImage: false }
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "See this", media: "https://example.com/image.png" },
    });

    // Text sent first, then link fallback
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(2);
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(1, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "See this" }],
      accountId: undefined,
    });
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(2, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/image.png" }],
      accountId: undefined,
    });
  });

  it("sends media-only message without text", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "", media: "https://example.com/file.pdf" },
    });

    // No text message sent (empty contents)
    // Non-image media falls back to link
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/file.pdf" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("ignores empty mentionUserIds string", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello", mentionUserIds: "" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  it("throws when no text or media is provided", async () => {
    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "send",
        cfg: {} as never,
        params: { to: "group:123", message: "" },
      }),
    ).rejects.toThrow("send requires text or media");
  });

  it("returns error from sendInfoflowMessage", async () => {
    mockSendInfoflowMessage.mockResolvedValue({ ok: false, error: "network timeout" });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello" },
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              channel: "infoflow",
              to: "group:123",
              messageId: "failed",
              error: "network timeout",
            },
            null,
            2,
          ),
        },
      ],
      details: {
        ok: false,
        channel: "infoflow",
        to: "group:123",
        messageId: "failed",
        error: "network timeout",
      },
    });
  });

  it("passes accountId through to sendInfoflowMessage", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "group:123", message: "Hello" },
      accountId: "my-account",
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: "my-account",
    });
  });

  it("combines @all with media", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: {
        to: "group:123",
        message: "Check the doc",
        atAll: true,
        media: "https://example.com/doc.pdf",
      },
    });

    // Text+mentions sent first, then non-image media falls back to link
    expect(mockSendInfoflowMessage).toHaveBeenCalledTimes(2);
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(1, {
      cfg: {},
      to: "group:123",
      contents: [
        { type: "at", content: "all" },
        { type: "markdown", content: "@all Check the doc" },
      ],
      accountId: undefined,
    });
    expect(mockSendInfoflowMessage).toHaveBeenNthCalledWith(2, {
      cfg: {},
      to: "group:123",
      contents: [{ type: "link", content: "https://example.com/doc.pdf" }],
      accountId: undefined,
    });
  });

  it("normalizes infoflow: prefix from target", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "send",
      cfg: {} as never,
      params: { to: "infoflow:group:123", message: "Hello" },
    });

    expect(mockSendInfoflowMessage).toHaveBeenCalledWith({
      cfg: {},
      to: "group:123",
      contents: [{ type: "markdown", content: "Hello" }],
      accountId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Delete action — Mode A: by messageId
  // -------------------------------------------------------------------------

  it("recalls a group message with explicit msgseqid", async () => {
    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", messageId: "456", msgseqid: "789" },
    });

    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledWith({
      account: expect.objectContaining({ accountId: "default" }),
      groupId: 123,
      messageid: "456",
      msgseqid: "789",
    });
    expect(result).toMatchObject({
      details: { ok: true, channel: "infoflow", to: "group:123" },
    });
    expect(mockRemoveRecalledMessages).toHaveBeenCalledWith("default", ["456"]);
  });

  it("looks up msgseqid from store when not provided", async () => {
    mockFindSentMessage.mockReturnValue({
      target: "group:123",
      messageid: "456",
      msgseqid: "789",
      digest: "hello",
      sentAt: Date.now(),
    });

    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", messageId: "456" },
    });

    expect(mockFindSentMessage).toHaveBeenCalledWith("default", "456");
    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageid: "456", msgseqid: "789" }),
    );
  });

  it("throws with candidate hint when messageId not found in store and no fallback available", async () => {
    mockFindSentMessage.mockReturnValue(undefined);
    mockQuerySentMessages.mockReturnValue([]);

    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "delete" as never,
        cfg: {} as never,
        params: { to: "group:123", messageId: "456" },
      }),
    ).rejects.toThrow(/not a known bot-sent message/);
  });

  it("throws when delete target is private and appAgentId is not configured", async () => {
    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "delete" as never,
        cfg: {} as never,
        params: { to: "user1", messageId: "456" },
      }),
    ).rejects.toThrow("Infoflow private message recall requires appAgentId configuration");
  });

  it("returns error from recallInfoflowGroupMessage", async () => {
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: false, error: "message expired" });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", messageId: "456", msgseqid: "789" },
    });

    expect(result).toMatchObject({
      details: { ok: false, channel: "infoflow", to: "group:123", error: "message expired" },
    });
    // Should NOT remove from store on failure
    expect(mockRemoveRecalledMessages).not.toHaveBeenCalled();
  });

  it("normalizes infoflow: prefix for delete target", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "infoflow:group:123", messageId: "456", msgseqid: "789" },
    });

    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 123 }),
    );
  });

  // -------------------------------------------------------------------------
  // Delete action — Mode B: batch recall by count
  // -------------------------------------------------------------------------

  it("batch recalls messages by count", async () => {
    mockQuerySentMessages.mockReturnValue([
      { target: "group:123", messageid: "msg-1", msgseqid: "seq-1", digest: "hello", sentAt: 3000 },
      { target: "group:123", messageid: "msg-2", msgseqid: "seq-2", digest: "world", sentAt: 2000 },
    ]);
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: true });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", count: "5" },
    });

    expect(mockQuerySentMessages).toHaveBeenCalledWith("default", {
      target: "group:123",
      count: 5,
    });
    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledTimes(2);
    expect(mockRemoveRecalledMessages).toHaveBeenCalledWith("default", ["msg-1", "msg-2"]);
    expect(result).toMatchObject({
      details: { ok: true, recalled: 2, failed: 0, total: 2 },
    });
  });

  it("skips records without msgseqid in batch mode", async () => {
    mockQuerySentMessages.mockReturnValue([
      { target: "group:123", messageid: "msg-1", msgseqid: "seq-1", digest: "hello", sentAt: 3000 },
      { target: "group:123", messageid: "msg-2", msgseqid: "", digest: "private", sentAt: 2000 },
    ]);
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: true });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", count: "10" },
    });

    // Only msg-1 has msgseqid, so only 1 recall call
    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      details: { ok: true, recalled: 1, total: 1 },
    });
  });

  it("returns success with 0 recalled when no messages in store", async () => {
    mockQuerySentMessages.mockReturnValue([]);

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", count: "10" },
    });

    expect(mockRecallInfoflowGroupMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: { ok: true, recalled: 0 },
    });
  });

  it("reports partial failures in batch mode", async () => {
    mockQuerySentMessages.mockReturnValue([
      { target: "group:123", messageid: "msg-1", msgseqid: "seq-1", digest: "hello", sentAt: 3000 },
      { target: "group:123", messageid: "msg-2", msgseqid: "seq-2", digest: "world", sentAt: 2000 },
    ]);
    mockRecallInfoflowGroupMessage
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "message expired" });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", count: "5" },
    });

    expect(result).toMatchObject({
      details: { ok: false, recalled: 1, failed: 1, total: 2 },
    });
    // Only the successful one should be removed from store
    expect(mockRemoveRecalledMessages).toHaveBeenCalledWith("default", ["msg-1"]);
  });

  it("defaults to count=1 when neither messageId nor count is provided", async () => {
    mockQuerySentMessages.mockReturnValue([
      {
        target: "group:123",
        messageid: "msg-1",
        msgseqid: "seq-1",
        digest: "latest",
        sentAt: Date.now(),
      },
    ]);
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: true });

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123" },
    });

    expect(mockQuerySentMessages).toHaveBeenCalledWith("default", {
      target: "group:123",
      count: 1,
    });
    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      details: { ok: true, recalled: 1 },
    });
  });

  it("passes accountId through to delete action", async () => {
    await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:123", messageId: "456", msgseqid: "789" },
      accountId: "my-account",
    });

    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 123,
        messageid: "456",
        msgseqid: "789",
      }),
    );
  });
});

describe("delete handler — replyToMessageId fallback", () => {
  beforeEach(() => {
    _resetInboundContext();
    mockFindSentMessage.mockReset();
    mockQuerySentMessages.mockReset();
    mockRecallInfoflowGroupMessage.mockReset();
    mockRecallInfoflowGroupMessage.mockResolvedValue({ ok: true });
    mockRemoveRecalledMessages.mockReset();
  });

  it("group: falls back to replyToMessageId when LLM-passed messageId is unknown", async () => {
    // Register inbound context: user message id=USER123 quote-replied to bot message BOT999
    registerInboundContext({
      accountId: "default",
      target: "group:42",
      inboundMessageId: "USER123",
      replyToMessageId: "BOT999",
      replyTargets: [{ messageid: "BOT999", preview: "joke", isBotMessage: true }],
      registeredAt: Date.now(),
    });

    // findSentMessage: USER123 → undefined; BOT999 → found with msgseqid
    mockFindSentMessage.mockImplementation((_acct: string, id: string) =>
      id === "BOT999"
        ? {
            target: "group:42",
            from: "agent:1",
            messageid: "BOT999",
            msgseqid: "SEQ-99",
            digest: "joke",
            sentAt: Date.now(),
          }
        : undefined,
    );

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "group:42", messageId: "USER123" }, // LLM passed the WRONG id
      toolContext: { currentMessageId: "USER123" } as never,
    });

    expect(mockRecallInfoflowGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 42, messageid: "BOT999", msgseqid: "SEQ-99" }),
    );
    expect((result as { details: { messageId: string } }).details.messageId).toBe("BOT999");
  });

  it("group: throws with candidate list when LLM id unknown and no replyToMessageId available", async () => {
    mockFindSentMessage.mockReturnValue(undefined);
    mockQuerySentMessages.mockReturnValue([
      {
        target: "group:42",
        from: "a",
        messageid: "BOT-A",
        msgseqid: "S-A",
        digest: "笑话: ...",
        sentAt: Date.now(),
      },
    ]);

    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "delete" as never,
        cfg: {} as never,
        params: { to: "group:42", messageId: "WRONG" },
        toolContext: { currentMessageId: "USER999" } as never,
      }),
    ).rejects.toThrow(/Recent bot-sent messages here.*BOT-A/);
  });

  it("group: does not fall back across account/target mismatch", async () => {
    // Context registered for a DIFFERENT target
    registerInboundContext({
      accountId: "default",
      target: "group:OTHER",
      inboundMessageId: "USER123",
      replyToMessageId: "BOT999",
      registeredAt: Date.now(),
    });
    mockFindSentMessage.mockReturnValue(undefined);
    mockQuerySentMessages.mockReturnValue([]);

    await expect(
      infoflowMessageActions.handleAction!({
        channel: "infoflow",
        action: "delete" as never,
        cfg: {} as never,
        params: { to: "group:42", messageId: "USER123" },
        toolContext: { currentMessageId: "USER123" } as never,
      }),
    ).rejects.toThrow(/not a known bot-sent message/);
    expect(mockRecallInfoflowGroupMessage).not.toHaveBeenCalled();
  });

  it("private: falls back to replyToMessageId for DM recall", async () => {
    // Mock account with appAgentId configured (private recall needs it)
    const accountsModule = await import("./accounts.js");
    (accountsModule.resolveInfoflowAccount as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        apiHost: "https://api.infoflow.test",
        appKey: "key",
        appSecret: "secret",
        checkToken: "tok",
        encodingAESKey: "aes",
        appAgentId: 12345,
      },
    });

    registerInboundContext({
      accountId: "default",
      target: "alice",
      inboundMessageId: "U1",
      replyToMessageId: "BOT-MSG",
      registeredAt: Date.now(),
    });
    mockFindSentMessage.mockImplementation((_a: string, id: string) =>
      id === "BOT-MSG"
        ? {
            target: "alice",
            from: "agent:1",
            messageid: "BOT-MSG",
            msgseqid: "",
            digest: "hi",
            sentAt: Date.now(),
          }
        : undefined,
    );

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "alice", messageId: "WRONG-LLM-ID" },
      toolContext: { currentMessageId: "U1" } as never,
    });

    expect(mockRecallInfoflowPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msgkey: "BOT-MSG", appAgentId: 12345 }),
    );
    expect((result as { details: { messageId: string } }).details.messageId).toBe("BOT-MSG");
  });

  it("private (regression): unknown messageId + NO fallback → passes through to API (does NOT throw)", async () => {
    // This is the regression check: original DM behavior was permissive.
    // Even when the store has no record of the messageId, we attempt the recall
    // and let the Infoflow backend decide. We MUST NOT block on store-miss.
    const accountsModule = await import("./accounts.js");
    (accountsModule.resolveInfoflowAccount as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        apiHost: "https://api.infoflow.test",
        appKey: "key",
        appSecret: "secret",
        checkToken: "tok",
        encodingAESKey: "aes",
        appAgentId: 12345,
      },
    });
    mockFindSentMessage.mockReturnValue(undefined);
    // No inbound context registered → no fallback available.

    const result = await infoflowMessageActions.handleAction!({
      channel: "infoflow",
      action: "delete" as never,
      cfg: {} as never,
      params: { to: "alice", messageId: "SOME-LEGITIMATE-OLD-ID" },
    });

    expect(mockRecallInfoflowPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msgkey: "SOME-LEGITIMATE-OLD-ID" }),
    );
    expect((result as { details: { ok: boolean } }).details.ok).toBe(true);
  });
});
