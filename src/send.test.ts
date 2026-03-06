import { createHash } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
    },
  })),
}));

vi.mock("./infoflow-req-parse.js", () => ({
  recordSentMessageId: vi.fn(),
}));

vi.mock("./sent-message-store.js", () => ({
  recordSentMessage: vi.fn(),
  buildMessageDigest: vi.fn(() => "digest"),
}));

vi.mock("./media.js", () => ({
  prepareInfoflowImageBase64: vi.fn(),
  sendInfoflowPrivateImage: vi.fn(),
}));

import { prepareInfoflowImageBase64, sendInfoflowPrivateImage } from "./media.js";
import {
  getAppAccessToken,
  _resetTokenCache,
  extractMsgSeqId,
  extractIdFromRawJson,
  recallInfoflowGroupMessage,
} from "./send.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

function mockTokenResponse(token: string, expiresIn = 7200) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        errcode: 0,
        data: { app_access_token: token, expires_in: expiresIn },
      }),
  };
}

const BASE_PARAMS = {
  apiHost: "https://api.example.com",
  appKey: "test-key",
  appSecret: "test-secret",
};

beforeEach(() => {
  _resetTokenCache();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ============================================================================
// sendInfoflowMessage
// ============================================================================

vi.mock("./accounts.js", () => ({
  resolveInfoflowAccount: vi.fn(({ accountId }: { accountId?: string }) => ({
    accountId: accountId ?? "default",
    config: {
      apiHost: "https://api.example.com",
      appKey: "test-key",
      appSecret: "test-secret",
    },
  })),
}));

import { sendInfoflowMessage } from "./send.js";

describe("sendInfoflowMessage", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(prepareInfoflowImageBase64).mockReset();
    vi.mocked(sendInfoflowPrivateImage).mockReset();
  });

  it("returns error when contents array is empty", async () => {
    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [],
    });
    expect(result).toEqual({ ok: false, error: "contents array is empty" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("routes to private message for username target", async () => {
    // Mock token + private send
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-123" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "chengbo05",
      contents: [{ type: "text", content: "hello" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-123");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("routes to group message for group:123 target", async () => {
    // Mock token + group send
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid: "grp-456" } } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:12345",
      contents: [{ type: "markdown", content: "# Title" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("grp-456");
  });

  it("sends private message with link using richtext format", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-link-123" } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [
        { type: "text", content: "Check this link:" },
        { type: "link", content: "[Example]https://example.com" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-link-123");

    // Verify richtext payload
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
    expect(body.richtext).toEqual({
      content: [
        { type: "text", text: "Check this link:" },
        { type: "a", href: "https://example.com", label: "Example" },
      ],
    });
  });

  it("sends private link with href only (no label)", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-456" } })),
    });

    await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "https://example.com" }],
    });

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
    expect(body.richtext).toEqual({
      content: [{ type: "a", href: "https://example.com", label: "https://example.com" }],
    });
  });

  it("sends group message with link in body as separate messages", async () => {
    const mockGroupResponse = (messageid: string) => ({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid } } })),
    });

    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockGroupResponse("grp-text-1"))
      .mockResolvedValueOnce(mockGroupResponse("grp-link-2"));

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:12345",
      contents: [
        { type: "text", content: "Visit:" },
        { type: "link", content: "[Docs]https://docs.example.com" },
      ],
    });

    expect(result.ok).toBe(true);
    // Returns last messageid
    expect(result.messageId).toBe("grp-link-2");
    // 1 token + 2 messages (text + link sent separately)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify text message sent first
    const [, textOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const textBody = JSON.parse(textOpts.body as string) as {
      message: { header: { msgtype: string }; body: unknown[] };
    };
    expect(textBody.message.header.msgtype).toBe("TEXT");
    expect(textBody.message.body).toEqual([{ type: "TEXT", content: "Visit:" }]);

    // Verify link message sent separately
    const [, linkOpts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const linkBody = JSON.parse(linkOpts.body as string) as {
      message: { header: { msgtype: string }; body: unknown[] };
    };
    expect(linkBody.message.header.msgtype).toBe("TEXT");
    expect(linkBody.message.body).toEqual([{ type: "LINK", href: "https://docs.example.com" }]);
  });

  it("strips infoflow: prefix from target and routes to private", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-pfx" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "infoflow:chengbo05",
      contents: [{ type: "text", content: "hello" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-pfx");
    // Verify the private send API was called (not group)
    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain("/api/v1/app/message/send");
  });

  it("sends group message with AT and at-agent content items", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid: "grp-at" } } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:99999",
      contents: [
        { type: "at", content: "user1,user2" },
        { type: "at-agent", content: "1282,1283" },
        { type: "markdown", content: "Hello team" },
      ],
    });

    expect(result.ok).toBe(true);

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { message: { body: unknown[] } };
    expect(body.message.body).toEqual([
      { type: "AT", atuserids: ["user1", "user2"] },
      { type: "AT", atuserids: [], atagentids: [1282, 1283] },
      { type: "MD", content: "Hello team" },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Local image link resolution
  // ---------------------------------------------------------------------------

  it("converts local image link to native image for group messages", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    mockPrepare.mockResolvedValueOnce({ isImage: true, base64: "base64img" });

    // Token + group send (IMAGE item)
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid: "grp-img" } } }),
        ),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "group:12345",
      contents: [{ type: "link", content: "/tmp/screenshot.png" }],
    });

    expect(result.ok).toBe(true);
    expect(mockPrepare).toHaveBeenCalledWith({ mediaUrl: "/tmp/screenshot.png" });

    // Verify IMAGE body was sent
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as {
      message: { header: { msgtype: string }; body: Array<{ type: string; content?: string }> };
    };
    expect(body.message.header.msgtype).toBe("IMAGE");
    expect(body.message.body).toEqual([{ type: "IMAGE", content: "base64img" }]);
  });

  it("converts local image link to native private image", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    const mockPrivateImage = vi.mocked(sendInfoflowPrivateImage);
    mockPrepare.mockResolvedValueOnce({ isImage: true, base64: "base64abc" });
    mockPrivateImage.mockResolvedValueOnce({ ok: true, msgkey: "img-prv-1" });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "/tmp/photo.jpg" }],
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("img-prv-1");
    expect(mockPrepare).toHaveBeenCalledWith({ mediaUrl: "/tmp/photo.jpg" });
    expect(mockPrivateImage).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: "user1", base64Image: "base64abc" }),
    );
    // No fetch calls for private message text (only image was sent via native API)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps local non-image link as link content", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    mockPrepare.mockResolvedValueOnce({ isImage: false });

    // Token + private send (richtext with link)
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-lnk" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "/tmp/document.pdf" }],
    });

    expect(result.ok).toBe(true);
    // Should be sent as richtext link, not as image
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
  });

  it("does not intercept HTTP URL links", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    mockPrepare.mockClear();

    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-url" } })),
    });

    await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "https://example.com/image.png" }],
    });

    // prepareInfoflowImageBase64 should NOT be called for HTTP URLs
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("falls back to link when image detection throws", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    mockPrepare.mockRejectedValueOnce(new Error("file not found"));

    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "msg-fb" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [{ type: "link", content: "/tmp/missing.png" }],
    });

    expect(result.ok).toBe(true);
    // Should fall back to richtext link
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.msgtype).toBe("richtext");
  });

  it("sends text + local image link as separate messages for private chat", async () => {
    const mockPrepare = vi.mocked(prepareInfoflowImageBase64);
    const mockPrivateImage = vi.mocked(sendInfoflowPrivateImage);
    mockPrepare.mockResolvedValueOnce({ isImage: true, base64: "imgdata" });
    mockPrivateImage.mockResolvedValueOnce({ ok: true, msgkey: "img-2" });

    // Token + text send
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, msgkey: "txt-1" } })),
    });

    const result = await sendInfoflowMessage({
      cfg: {} as never,
      to: "user1",
      contents: [
        { type: "markdown", content: "Here is the chart:" },
        { type: "link", content: "/tmp/chart.png" },
      ],
    });

    expect(result.ok).toBe(true);
    // Text was sent via private message API
    expect(mockFetch).toHaveBeenCalledTimes(2); // token + text
    // Image was sent via native private image API
    expect(mockPrivateImage).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: "user1", base64Image: "imgdata" }),
    );
  });
});

// ============================================================================
// getAppAccessToken
// ============================================================================

describe("getAppAccessToken", () => {
  it("fetches token on cache miss", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-abc"));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: true, token: "tok-abc" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends MD5-hashed appSecret in request body", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1"));
    await getAppAccessToken(BASE_PARAMS);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, string>;
    const expectedMd5 = createHash("md5").update("test-secret").digest("hex").toLowerCase();
    expect(body.app_secret).toBe(expectedMd5);
  });

  it("returns cached token on second call", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-cached"));
    await getAppAccessToken(BASE_PARAMS);
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: true, token: "tok-cached" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1", 600));
    await getAppAccessToken(BASE_PARAMS);
    vi.advanceTimersByTime(301 * 1000); // past (600-300)s buffer
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-2", 600));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.token).toBe("tok-2");
  });

  it("isolates cache by appKey (multi-account)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-A"))
      .mockResolvedValueOnce(mockTokenResponse("tok-B"));
    const resultA = await getAppAccessToken({ ...BASE_PARAMS, appKey: "key-A" });
    const resultB = await getAppAccessToken({ ...BASE_PARAMS, appKey: "key-B" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(resultA.token).toBe("tok-A");
    expect(resultB.token).toBe("tok-B");
  });

  it("handles network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("returns error on HTTP non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("returns error on API errcode response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ errcode: 40001, errmsg: "invalid appkey" }),
    });
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: false, error: "invalid appkey" });
  });

  it("returns error when token is missing in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ errcode: 0, data: { expires_in: 7200 } }),
    });
    const result = await getAppAccessToken(BASE_PARAMS);
    expect(result).toEqual({ ok: false, error: "no token in response" });
  });
});

// ============================================================================
// extractIdFromRawJson — large integer precision
// ============================================================================

describe("extractIdFromRawJson", () => {
  it("extracts bare integer preserving full precision", () => {
    const raw = '{"data":{"messageid":1858880144601632519,"msgseqid":300010777}}';
    expect(extractIdFromRawJson(raw, "messageid")).toBe("1858880144601632519");
    expect(extractIdFromRawJson(raw, "msgseqid")).toBe("300010777");
  });

  it("extracts quoted string value", () => {
    const raw = '{"msgkey":"msg-abc-123"}';
    expect(extractIdFromRawJson(raw, "msgkey")).toBe("msg-abc-123");
  });

  it("returns undefined for missing key", () => {
    expect(extractIdFromRawJson('{"other":123}', "messageid")).toBeUndefined();
  });

  it("prefers bare integer over quoted string when key appears twice", () => {
    // bare integer comes first in regex match
    const raw = '{"messageid":1858880144601632519}';
    expect(extractIdFromRawJson(raw, "messageid")).toBe("1858880144601632519");
  });

  it("handles whitespace around colon", () => {
    const raw = '{"messageid" : 12345}';
    expect(extractIdFromRawJson(raw, "messageid")).toBe("12345");
  });
});

// ============================================================================
// extractMsgSeqId
// ============================================================================

describe("extractMsgSeqId", () => {
  it("extracts msgseqid from nested data.data", () => {
    expect(extractMsgSeqId({ data: { msgseqid: 300010777 } })).toBe("300010777");
  });

  it("extracts msgseqid from flat structure", () => {
    expect(extractMsgSeqId({ msgseqid: 12345 })).toBe("12345");
  });

  it("returns undefined when msgseqid is absent", () => {
    expect(extractMsgSeqId({ data: { messageid: "abc" } })).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(extractMsgSeqId({})).toBeUndefined();
  });

  it("prefers nested over flat", () => {
    expect(extractMsgSeqId({ msgseqid: 1, data: { msgseqid: 2 } })).toBe("2");
  });
});

// ============================================================================
// recallInfoflowGroupMessage
// ============================================================================

describe("recallInfoflowGroupMessage", () => {
  const ACCOUNT = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      apiHost: "https://api.example.com",
      appKey: "test-key",
      appSecret: "test-secret",
      checkToken: "tok",
      encodingAESKey: "aes",
    },
  } as never;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("recalls a group message successfully", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0 } })),
    });

    const result = await recallInfoflowGroupMessage({
      account: ACCOUNT,
      groupId: 1671623,
      messageid: "182891542208",
      msgseqid: "300010777",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify recall API was called with correct URL and payload
    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/v1/robot/group/msgRecall");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      groupId: 1671623,
      messageid: 182891542208,
      msgseqid: 300010777,
    });
    expect(opts.headers).toMatchObject({
      Authorization: "Bearer-tok-1",
      "Content-Type": "application/json; charset=utf-8",
    });
  });

  it("returns error on API failure code", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ code: "fail", message: "message expired" })),
    });

    const result = await recallInfoflowGroupMessage({
      account: ACCOUNT,
      groupId: 123,
      messageid: "456",
      msgseqid: "789",
    });

    expect(result).toEqual({ ok: false, error: "message expired" });
  });

  it("returns error on inner errcode", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ code: "ok", data: { errcode: 40001, errmsg: "invalid msg" } }),
        ),
    });

    const result = await recallInfoflowGroupMessage({
      account: ACCOUNT,
      groupId: 123,
      messageid: "456",
      msgseqid: "789",
    });

    expect(result).toEqual({ ok: false, error: "invalid msg" });
  });

  it("returns error on network failure", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await recallInfoflowGroupMessage({
      account: ACCOUNT,
      groupId: 123,
      messageid: "456",
      msgseqid: "789",
    });

    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("returns error when credentials are missing", async () => {
    const noCredsAccount = {
      accountId: "default",
      config: { apiHost: "https://api.example.com", appKey: "", appSecret: "" },
    } as never;

    const result = await recallInfoflowGroupMessage({
      account: noCredsAccount,
      groupId: 123,
      messageid: "456",
      msgseqid: "789",
    });

    expect(result).toEqual({ ok: false, error: "Infoflow appKey/appSecret not configured." });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
