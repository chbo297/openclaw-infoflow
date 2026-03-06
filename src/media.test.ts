import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const resizeToJpegMock = vi.fn();
const loadWebMediaMock = vi.fn();
const mediaKindFromMimeMock = vi.fn();

vi.mock("./runtime.js", () => ({
  getInfoflowRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: () => false,
      logVerbose: () => {},
      getChildLogger: () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }),
    },
    media: {
      resizeToJpeg: resizeToJpegMock,
      loadWebMedia: loadWebMediaMock,
      mediaKindFromMime: mediaKindFromMimeMock,
    },
  })),
}));

vi.mock("./infoflow-req-parse.js", () => ({
  recordSentMessageId: vi.fn(),
}));

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

import {
  compressImageForInfoflow,
  prepareInfoflowImageBase64,
  sendInfoflowGroupImage,
  sendInfoflowPrivateImage,
  sendInfoflowImageMessage,
} from "./media.js";
import { _resetTokenCache } from "./send.js";

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

function mockGroupSendResponse(messageid: string) {
  return {
    ok: true,
    text: () =>
      Promise.resolve(JSON.stringify({ code: "ok", data: { errcode: 0, data: { messageid } } })),
  };
}

function mockPrivateSendResponse(msgkey: string) {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ errcode: 0, msgkey })),
  };
}

beforeEach(() => {
  _resetTokenCache();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  resizeToJpegMock.mockReset();
  loadWebMediaMock.mockReset();
  mediaKindFromMimeMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// compressImageForInfoflow
// ============================================================================

describe("compressImageForInfoflow", () => {
  it("returns buffer as-is when under 1MB", async () => {
    const small = Buffer.alloc(500 * 1024); // 500KB
    const result = await compressImageForInfoflow({ buffer: small });
    expect(result).toBe(small);
    expect(resizeToJpegMock).not.toHaveBeenCalled();
  });

  it("compresses large images via resizeToJpeg", async () => {
    const large = Buffer.alloc(2 * 1024 * 1024); // 2MB
    const compressed = Buffer.alloc(800 * 1024); // 800KB
    resizeToJpegMock.mockResolvedValue(compressed);

    const result = await compressImageForInfoflow({ buffer: large });
    expect(result).toBe(compressed);
    expect(resizeToJpegMock).toHaveBeenCalled();
  });

  it("returns null for GIF exceeding 1MB", async () => {
    const largeGif = Buffer.alloc(2 * 1024 * 1024);
    const result = await compressImageForInfoflow({
      buffer: largeGif,
      contentType: "image/gif",
    });
    expect(result).toBeNull();
    expect(resizeToJpegMock).not.toHaveBeenCalled();
  });

  it("returns null when all compression combos exceed 1MB", async () => {
    const large = Buffer.alloc(2 * 1024 * 1024);
    // All combos still produce > 1MB
    resizeToJpegMock.mockResolvedValue(Buffer.alloc(1.5 * 1024 * 1024));

    const result = await compressImageForInfoflow({ buffer: large });
    expect(result).toBeNull();
  });
});

// ============================================================================
// prepareInfoflowImageBase64
// ============================================================================

describe("prepareInfoflowImageBase64", () => {
  it("returns base64 for image media", async () => {
    const imgBuffer = Buffer.from("fake-image-data");
    loadWebMediaMock.mockResolvedValue({
      buffer: imgBuffer,
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    mediaKindFromMimeMock.mockReturnValue("image");

    const result = await prepareInfoflowImageBase64({ mediaUrl: "https://example.com/photo.jpg" });
    expect(result).toEqual({ isImage: true, base64: imgBuffer.toString("base64") });
  });

  it("returns isImage:false for non-image media", async () => {
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "doc.pdf",
    });
    mediaKindFromMimeMock.mockReturnValue("document");

    const result = await prepareInfoflowImageBase64({ mediaUrl: "https://example.com/doc.pdf" });
    expect(result).toEqual({ isImage: false });
  });

  it("returns isImage:false when compression fails", async () => {
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024);
    loadWebMediaMock.mockResolvedValue({
      buffer: largeBuffer,
      contentType: "image/gif",
      fileName: "big.gif",
    });
    mediaKindFromMimeMock.mockReturnValue("image");

    const result = await prepareInfoflowImageBase64({ mediaUrl: "https://example.com/big.gif" });
    expect(result).toEqual({ isImage: false });
  });

  it("passes mediaLocalRoots to loadWebMedia", async () => {
    const imgBuffer = Buffer.from("local-image");
    loadWebMediaMock.mockResolvedValue({
      buffer: imgBuffer,
      contentType: "image/png",
      fileName: "local.png",
    });
    mediaKindFromMimeMock.mockReturnValue("image");

    await prepareInfoflowImageBase64({
      mediaUrl: "/allowed/path/img.png",
      mediaLocalRoots: ["/allowed/path"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/allowed/path/img.png",
      expect.objectContaining({ localRoots: ["/allowed/path"] }),
    );
  });
});

// ============================================================================
// sendInfoflowGroupImage
// ============================================================================

describe("sendInfoflowGroupImage", () => {
  const account = {
    accountId: "default",
    config: {
      apiHost: "https://api.example.com",
      appKey: "test-key",
      appSecret: "test-secret",
    },
  } as never;

  it("sends IMAGE payload to group API", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockGroupSendResponse("img-msg-1"));

    const result = await sendInfoflowGroupImage({
      account,
      groupId: 12345,
      base64Image: "AQIDBA==",
    });

    expect(result.ok).toBe(true);
    expect(result.messageid).toBe("img-msg-1");

    // Verify payload structure
    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/v1/robot/msg/groupmsgsend");
    const body = JSON.parse(opts.body as string) as {
      message: { header: Record<string, unknown>; body: unknown[] };
    };
    expect(body.message.header.msgtype).toBe("IMAGE");
    expect(body.message.header.toid).toBe(12345);
    expect(body.message.header.totype).toBe("GROUP");
    expect(body.message.body).toEqual([{ type: "IMAGE", content: "AQIDBA==" }]);
  });

  it("returns error when appKey is missing", async () => {
    const badAccount = {
      accountId: "bad",
      config: { apiHost: "https://api.example.com", appKey: "", appSecret: "" },
    } as never;
    const result = await sendInfoflowGroupImage({
      account: badAccount,
      groupId: 1,
      base64Image: "AA==",
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// sendInfoflowPrivateImage
// ============================================================================

describe("sendInfoflowPrivateImage", () => {
  const account = {
    accountId: "default",
    config: {
      apiHost: "https://api.example.com",
      appKey: "test-key",
      appSecret: "test-secret",
    },
  } as never;

  it("sends image payload to private API", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockPrivateSendResponse("pm-img-1"));

    const result = await sendInfoflowPrivateImage({
      account,
      toUser: "testuser",
      base64Image: "AQIDBA==",
    });

    expect(result.ok).toBe(true);
    expect(result.msgkey).toBe("pm-img-1");

    // Verify payload structure
    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/api/v1/app/message/send");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.touser).toBe("testuser");
    expect(body.msgtype).toBe("image");
    expect(body.image).toEqual({ content: "AQIDBA==" });
  });

  it("returns error on API failure", async () => {
    mockFetch.mockResolvedValueOnce(mockTokenResponse("tok-1")).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ errcode: 40003, errmsg: "invalid user" })),
    });

    const result = await sendInfoflowPrivateImage({
      account,
      toUser: "baduser",
      base64Image: "AA==",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid user");
  });
});

// ============================================================================
// sendInfoflowImageMessage (unified dispatcher)
// ============================================================================

describe("sendInfoflowImageMessage", () => {
  it("routes group target to group image send", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockGroupSendResponse("grp-img-1"));

    const result = await sendInfoflowImageMessage({
      cfg: {} as never,
      to: "group:99999",
      base64Image: "AQIDBA==",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("grp-img-1");
    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain("/api/v1/robot/msg/groupmsgsend");
  });

  it("routes username target to private image send", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockPrivateSendResponse("pm-img-1"));

    const result = await sendInfoflowImageMessage({
      cfg: {} as never,
      to: "testuser",
      base64Image: "AQIDBA==",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("pm-img-1");
    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain("/api/v1/app/message/send");
  });

  it("strips infoflow: prefix before routing", async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse("tok-1"))
      .mockResolvedValueOnce(mockGroupSendResponse("grp-pfx"));

    const result = await sendInfoflowImageMessage({
      cfg: {} as never,
      to: "infoflow:group:12345",
      base64Image: "AA==",
    });

    expect(result.ok).toBe(true);
    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain("/api/v1/robot/msg/groupmsgsend");
  });
});
