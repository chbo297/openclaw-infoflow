import { beforeEach, describe, it, expect, vi } from "vitest";

const mockFindSentMessage = vi.hoisted(() => vi.fn());
const mockQuerySentMessages = vi.hoisted(() => vi.fn());
vi.mock("./sent-message-store.js", () => ({
  findSentMessage: mockFindSentMessage,
  querySentMessages: mockQuerySentMessages,
}));

import {
  _checkBotMentioned as checkBotMentioned,
  _checkWatchMentioned as checkWatchMentioned,
  _extractMentionIds as extractMentionIds,
  _checkWatchRegex as checkWatchRegex,
  _checkReplyToBot as checkReplyToBot,
  _resolveReplyTargets as resolveReplyTargets,
  _buildGroupOutputHygienePrompt as buildGroupOutputHygienePrompt,
  _looksLikeRecallIntent as looksLikeRecallIntent,
  _buildBotRecentMessagesSection as buildBotRecentMessagesSection,
  _formatQuotedReplyTargetsSection as formatQuotedReplyTargetsSection,
} from "./bot.js";

describe("buildGroupOutputHygienePrompt", () => {
  it("requires conclusion-style group output, subagent for multi-step, and no raw tool dumps", () => {
    const s = buildGroupOutputHygienePrompt();
    expect(s).toContain("# Group chat output");
    expect(s).toContain("subagent");
    expect(s).toMatch(/tool-call|tool call/i);
    expect(s).toMatch(/retrieval|search/i);
  });
});

describe("checkBotMentioned", () => {
  // Case 1: Missing robotName should return false
  it("returns false when robotName is undefined", () => {
    const bodyItems = [{ type: "AT", name: "TestBot" }];
    expect(checkBotMentioned(bodyItems, undefined)).toBe(false);
  });

  it("returns false when robotName is empty string", () => {
    const bodyItems = [{ type: "AT", name: "TestBot" }];
    expect(checkBotMentioned(bodyItems, "")).toBe(false);
  });

  // Case 2: Empty body array should return false
  it("returns false when body array is empty", () => {
    expect(checkBotMentioned([], "TestBot")).toBe(false);
  });

  // Case 3: Case-insensitive matching
  it("matches robotName case-insensitively", () => {
    expect(checkBotMentioned([{ type: "AT", name: "testbot" }], "TestBot")).toBe(true);
    expect(checkBotMentioned([{ type: "AT", name: "TESTBOT" }], "TestBot")).toBe(true);
    expect(checkBotMentioned([{ type: "AT", name: "TeStBoT" }], "testbot")).toBe(true);
  });

  // Case 4: Exact match
  it("returns true for exact name match", () => {
    const bodyItems = [{ type: "AT", name: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(true);
  });

  // Case 5: No match
  it("returns false when AT name does not match robotName", () => {
    const bodyItems = [{ type: "AT", name: "OtherBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 6: Multiple items in body
  it("returns true when one of multiple items matches", () => {
    const bodyItems = [
      { type: "TEXT", content: "Hello" },
      { type: "AT", name: "OtherUser" },
      { type: "AT", name: "MyBot" },
      { type: "TEXT", content: "world" },
    ];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(true);
  });

  it("returns false when no AT items match in multiple items", () => {
    const bodyItems = [
      { type: "TEXT", content: "Hello" },
      { type: "AT", name: "OtherUser" },
      { type: "LINK", label: "example.com" },
    ];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 7: AT item without name field
  it("returns false when AT item has no name", () => {
    const bodyItems = [{ type: "AT", robotid: 123 }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  it("returns false when AT item has empty name", () => {
    const bodyItems = [{ type: "AT", name: "" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 8: Non-AT types should be ignored
  it("ignores TEXT type items", () => {
    const bodyItems = [{ type: "TEXT", content: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  it("ignores LINK type items", () => {
    const bodyItems = [{ type: "LINK", label: "MyBot" }];
    expect(checkBotMentioned(bodyItems, "MyBot")).toBe(false);
  });

  // Case 9: Partial match should not count
  it("returns false for partial name match (either direction)", () => {
    expect(checkBotMentioned([{ type: "AT", name: "MyBotHelper" }], "MyBot")).toBe(false);
    expect(checkBotMentioned([{ type: "AT", name: "Bot" }], "MyBot")).toBe(false);
  });

  it("matches by appAgentId vs AT robotid when robotName is absent", () => {
    const bodyItems = [{ type: "AT", robotid: 123 }];
    expect(checkBotMentioned(bodyItems, { appAgentId: 123 })).toBe(true);
    expect(checkBotMentioned(bodyItems, { appAgentId: 999 })).toBe(false);
  });

  it("matches by robotId vs AT robotid", () => {
    const bodyItems = [{ type: "AT", robotid: 42 }];
    expect(checkBotMentioned(bodyItems, { robotId: "42" })).toBe(true);
    expect(checkBotMentioned(bodyItems, { robotId: "99" })).toBe(false);
  });
});

describe("checkWatchMentioned", () => {
  it("returns undefined when watchMentions is empty", () => {
    const bodyItems = [{ type: "AT", name: "Alice" }];
    expect(checkWatchMentioned(bodyItems, [])).toBeUndefined();
  });

  it("returns undefined when body is empty", () => {
    expect(checkWatchMentioned([], ["Alice"])).toBeUndefined();
  });

  it("returns matched name on exact match", () => {
    const bodyItems = [{ type: "AT", name: "Alice" }];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBe("Alice");
  });

  it("matches case-insensitively and returns the ID from watchMentions", () => {
    const bodyItems = [{ type: "AT", name: "alice" }];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBe("Alice");
  });

  it("matches case-insensitively (uppercase input) and returns the ID from watchMentions", () => {
    const bodyItems = [{ type: "AT", name: "ALICE" }];
    expect(checkWatchMentioned(bodyItems, ["alice"])).toBe("alice");
  });

  it("returns undefined when no watch names are mentioned", () => {
    const bodyItems = [{ type: "AT", name: "Bob" }];
    expect(checkWatchMentioned(bodyItems, ["Alice", "Charlie"])).toBeUndefined();
  });

  it("returns first match when multiple watch names are present", () => {
    const bodyItems = [
      { type: "AT", name: "Bob" },
      { type: "AT", name: "Alice" },
      { type: "AT", name: "Charlie" },
    ];
    expect(checkWatchMentioned(bodyItems, ["Alice", "Charlie"])).toBe("Alice");
  });

  it("ignores non-AT items", () => {
    const bodyItems = [
      { type: "TEXT", content: "Alice" },
      { type: "LINK", label: "Alice" },
    ];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBeUndefined();
  });

  it("returns undefined when AT item has no name", () => {
    const bodyItems = [{ type: "AT", robotid: 123 }];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBeUndefined();
  });

  it("returns undefined when AT item has empty name", () => {
    const bodyItems = [{ type: "AT", name: "" }];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBeUndefined();
  });

  it("does not match partial names", () => {
    const bodyItems = [{ type: "AT", name: "AliceSmith" }];
    expect(checkWatchMentioned(bodyItems, ["Alice"])).toBeUndefined();
  });

  it("matches by userid and returns the ID from watchMentions", () => {
    const bodyItems = [{ type: "AT", userid: "chengbo05", name: "成博" }];
    expect(checkWatchMentioned(bodyItems, ["chengbo05"])).toBe("chengbo05");
  });

  it("matches by robotid (numeric) and returns the ID from watchMentions", () => {
    const bodyItems = [{ type: "AT", robotid: 4105000875, name: "SomeBot" }];
    expect(checkWatchMentioned(bodyItems, ["4105000875"])).toBe("4105000875");
  });

  it("prefers userid match over name match", () => {
    const bodyItems = [{ type: "AT", userid: "alice01", name: "Alice" }];
    // watchMentions contains the userid, should match by userid priority
    expect(checkWatchMentioned(bodyItems, ["alice01"])).toBe("alice01");
  });
});

describe("extractMentionIds", () => {
  it("returns empty lists when no AT items", () => {
    const result = extractMentionIds([{ type: "TEXT", content: "hello" }]);
    expect(result).toEqual({ userIds: [], agentIds: [] });
  });

  it("extracts human userid from AT items", () => {
    const bodyItems = [
      { type: "AT", userid: "chengbo05", name: "成博" },
      { type: "TEXT", content: " hello" },
    ];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: ["chengbo05"],
      agentIds: [],
    });
  });

  it("extracts robot agentId from AT items", () => {
    const bodyItems = [{ type: "AT", robotid: 4105000875, name: "otherbot" }];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: [],
      agentIds: [4105000875],
    });
  });

  it("extracts both human and robot IDs", () => {
    const bodyItems = [
      { type: "AT", robotid: 1282, name: "bot2" },
      { type: "AT", userid: "alice01", name: "Alice" },
      { type: "AT", userid: "bob02", name: "Bob" },
    ];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: ["alice01", "bob02"],
      agentIds: [1282],
    });
  });

  it("skips bot itself when robotName matches", () => {
    const bodyItems = [
      { type: "AT", robotid: 4105000875, name: "MyBot" },
      { type: "AT", userid: "alice01", name: "Alice" },
    ];
    expect(extractMentionIds(bodyItems, "MyBot")).toEqual({
      userIds: ["alice01"],
      agentIds: [],
    });
  });

  it("skips bot itself case-insensitively", () => {
    const bodyItems = [
      { type: "AT", robotid: 4105000875, name: "mybot" },
      { type: "AT", robotid: 1282, name: "otherbot" },
    ];
    expect(extractMentionIds(bodyItems, "MyBot")).toEqual({
      userIds: [],
      agentIds: [1282],
    });
  });

  it("deduplicates userIds (case-insensitive)", () => {
    const bodyItems = [
      { type: "AT", userid: "Alice01", name: "Alice" },
      { type: "AT", userid: "alice01", name: "Alice" },
    ];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: ["Alice01"],
      agentIds: [],
    });
  });

  it("deduplicates agentIds", () => {
    const bodyItems = [
      { type: "AT", robotid: 1282, name: "bot" },
      { type: "AT", robotid: 1282, name: "bot" },
    ];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: [],
      agentIds: [1282],
    });
  });

  it("ignores AT items without userid or robotid", () => {
    const bodyItems = [{ type: "AT", name: "unknown" }];
    expect(extractMentionIds(bodyItems)).toEqual({
      userIds: [],
      agentIds: [],
    });
  });
});

describe("checkWatchRegex", () => {
  it("matches multi-line content with dotAll pattern", () => {
    const text = "iphone crash 报警 异常\ntestrisk=3";
    const pattern = "^(?=.*iphone)(?=.*crash)(?=.*异常).*$";
    expect(checkWatchRegex(text, [pattern])).toBe(true);
  });

  it("returns true when any of multiple patterns matches", () => {
    const text = "hello world";
    expect(checkWatchRegex(text, ["nomatch", "world", "other"])).toBe(true);
    expect(checkWatchRegex(text, ["nomatch", "other"])).toBe(false);
  });

  it("returns false when pattern is invalid", () => {
    // Invalid regex is skipped; no match.
    expect(checkWatchRegex("test", ["["])).toBe(false);
  });

  it("returns false for empty patterns", () => {
    expect(checkWatchRegex("anything", [])).toBe(false);
  });
});

describe("checkReplyToBot", () => {
  it("returns false when body has no replyData items", () => {
    mockFindSentMessage.mockReset();
    const bodyItems = [
      { type: "TEXT", content: "hello" },
      { type: "AT", name: "Bot" },
    ];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(false);
    expect(mockFindSentMessage).not.toHaveBeenCalled();
  });

  it("returns false when replyData has no messageid", () => {
    mockFindSentMessage.mockReset();
    const bodyItems = [{ type: "replyData", content: "some quoted text" }];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(false);
    expect(mockFindSentMessage).not.toHaveBeenCalled();
  });

  it("returns true when replyData messageid matches a sent message", () => {
    mockFindSentMessage.mockReset();
    mockFindSentMessage.mockReturnValue({
      target: "group:123",
      from: "agent:100",
      messageid: "999",
      msgseqid: "",
      digest: "hello",
      sentAt: Date.now(),
    });
    const bodyItems = [{ type: "replyData", content: "quoted", messageid: "999" }];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(true);
    expect(mockFindSentMessage).toHaveBeenCalledWith("acct1", "999");
  });

  it("returns false when replyData messageid is not found in sent store", () => {
    mockFindSentMessage.mockReset();
    mockFindSentMessage.mockReturnValue(undefined);
    const bodyItems = [{ type: "replyData", content: "quoted", messageid: "888" }];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(false);
    expect(mockFindSentMessage).toHaveBeenCalledWith("acct1", "888");
  });

  it("handles numeric messageid by converting to string", () => {
    mockFindSentMessage.mockReset();
    mockFindSentMessage.mockReturnValue({
      target: "group:123",
      from: "agent:100",
      messageid: "7654321",
      msgseqid: "",
      digest: "test",
      sentAt: Date.now(),
    });
    const bodyItems = [{ type: "replyData", content: "quoted", messageid: 7654321 }];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(true);
    expect(mockFindSentMessage).toHaveBeenCalledWith("acct1", "7654321");
  });

  it("returns true if any replyData item matches (multiple quotes)", () => {
    mockFindSentMessage.mockReset();
    mockFindSentMessage.mockImplementation((_acct: string, id: string) => {
      if (id === "222") {
        return {
          target: "group:1",
          from: "agent:1",
          messageid: "222",
          msgseqid: "",
          digest: "",
          sentAt: 0,
        };
      }
      return undefined;
    });
    const bodyItems = [
      { type: "replyData", content: "not bot", messageid: "111" },
      { type: "replyData", content: "bot msg", messageid: "222" },
    ];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(true);
  });

  it("returns false gracefully when findSentMessage throws", () => {
    mockFindSentMessage.mockReset();
    mockFindSentMessage.mockImplementation(() => {
      throw new Error("DB error");
    });
    const bodyItems = [{ type: "replyData", content: "quoted", messageid: "123" }];
    expect(checkReplyToBot(bodyItems, "acct1")).toBe(false);
  });

  it("returns false when body is empty", () => {
    mockFindSentMessage.mockReset();
    expect(checkReplyToBot([], "acct1")).toBe(false);
  });
});

describe("resolveReplyTargets", () => {
  beforeEach(() => {
    mockFindSentMessage.mockReset();
  });

  it("returns empty array when no replyData items", () => {
    const out = resolveReplyTargets([{ type: "TEXT", content: "hi" }], "acct1");
    expect(out).toEqual([]);
  });

  it("returns structured entries with messageid + preview + isBotMessage=true when in store", () => {
    mockFindSentMessage.mockReturnValue({
      target: "group:1",
      from: "agent:1",
      messageid: "999",
      msgseqid: "",
      digest: "",
      sentAt: 0,
    });
    const out = resolveReplyTargets(
      [{ type: "replyData", content: "  joke about programmers  ", messageid: "999" }],
      "acct1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      messageid: "999",
      preview: "joke about programmers",
      isBotMessage: true,
    });
  });

  it("marks isBotMessage=false when not in store", () => {
    mockFindSentMessage.mockReturnValue(undefined);
    const out = resolveReplyTargets(
      [{ type: "replyData", content: "x", messageid: "111" }],
      "acct1",
    );
    expect(out[0].isBotMessage).toBe(false);
  });

  it("collects multiple replyData targets in order", () => {
    mockFindSentMessage.mockImplementation((_a: string, id: string) =>
      id === "222"
        ? { target: "g", from: "a", messageid: "222", msgseqid: "", digest: "", sentAt: 0 }
        : undefined,
    );
    const out = resolveReplyTargets(
      [
        { type: "replyData", content: "a", messageid: "111" },
        { type: "replyData", content: "b", messageid: "222" },
      ],
      "acct1",
    );
    expect(out.map((t) => t.messageid)).toEqual(["111", "222"]);
    expect(out.map((t) => t.isBotMessage)).toEqual([false, true]);
  });

  it("normalizes numeric messageid to string", () => {
    mockFindSentMessage.mockReturnValue(undefined);
    const out = resolveReplyTargets(
      [{ type: "replyData", content: "x", messageid: 7654321 }],
      "acct1",
    );
    expect(out[0].messageid).toBe("7654321");
  });
});

describe("looksLikeRecallIntent", () => {
  it.each([
    ["撤回上条消息", true],
    ["收回那条", true],
    ["删掉刚才那条笑话", true],
    ["删了它", true],
    ["请删除最后两条", true],
    ["recall the last one", true],
    ["unsend that", true],
    ["delete the last message", true],
    ["delete the previous 2 messages", true],
    ["delete that", true],
    ["delete those", true],
    ["你好世界", false],
    ["", false],
    ["just chatting about deletion of files", true /* digest matches 'delete' loosely? no — needs "delete that/those/the last/previous" */],
  ])("'%s' → %s", (text, expected) => {
    // The last row in the table is a bit liberal — our regex only matches "delete that/those/the last/previous"
    // so the chatting case should be FALSE. Adjust the expectation.
    if (text === "just chatting about deletion of files") {
      expect(looksLikeRecallIntent(text)).toBe(false);
      return;
    }
    expect(looksLikeRecallIntent(text)).toBe(expected);
  });
});

describe("formatQuotedReplyTargetsSection", () => {
  it("returns undefined for empty list", () => {
    expect(formatQuotedReplyTargetsSection([])).toBeUndefined();
  });

  it("renders each target with messageId + sentByBot + preview", () => {
    const out = formatQuotedReplyTargetsSection([
      { messageid: "999", preview: "joke text", isBotMessage: true },
    ]);
    expect(out).toBeDefined();
    expect(out!).toContain("messageId=999");
    expect(out!).toContain("sentByBot=true");
    expect(out!).toContain('preview="joke text"');
    expect(out!).toContain("recall/edit/quote");
  });
});

describe("buildBotRecentMessagesSection", () => {
  beforeEach(() => {
    mockQuerySentMessages.mockReset();
  });

  it("returns undefined when store returns no rows", () => {
    mockQuerySentMessages.mockReturnValue([]);
    expect(
      buildBotRecentMessagesSection({
        accountId: "a",
        target: "group:1",
        inboundLooksLikeRecall: false,
        isReplyToBot: false,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when all rows are older than 24h", () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    mockQuerySentMessages.mockReturnValue([
      { target: "group:1", from: "a", messageid: "1", msgseqid: "", digest: "old", sentAt: old },
    ]);
    expect(
      buildBotRecentMessagesSection({
        accountId: "a",
        target: "group:1",
        inboundLooksLikeRecall: false,
        isReplyToBot: false,
      }),
    ).toBeUndefined();
  });

  it("ambient mode: 5 rows max, short header, no recall instruction", () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        target: "group:1",
        from: "a",
        messageid: `m${i}`,
        msgseqid: "",
        digest: `msg ${i}`,
        sentAt: now - i * 1000,
      })),
    );
    const out = buildBotRecentMessagesSection({
      accountId: "a",
      target: "group:1",
      inboundLooksLikeRecall: false,
      isReplyToBot: false,
    });
    expect(out).toBeDefined();
    expect(out!.mode).toBe("ambient");
    expect(out!.count).toBe(5);
    expect(out!.text).toContain("for awareness");
    expect(mockQuerySentMessages).toHaveBeenCalledWith("a", { target: "group:1", count: 5 });
  });

  it("detail mode when inboundLooksLikeRecall: count=10, long header", () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue([
      { target: "g:1", from: "a", messageid: "m1", msgseqid: "", digest: "joke", sentAt: now },
    ]);
    const out = buildBotRecentMessagesSection({
      accountId: "a",
      target: "group:1",
      inboundLooksLikeRecall: true,
      isReplyToBot: false,
    });
    expect(out!.mode).toBe("detail");
    expect(out!.text).toContain("NEVER pass the current inbound message_id");
    expect(mockQuerySentMessages).toHaveBeenCalledWith("a", { target: "group:1", count: 10 });
  });

  it("detail mode also when isReplyToBot=true", () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue([
      { target: "g:1", from: "a", messageid: "m1", msgseqid: "", digest: "joke", sentAt: now },
    ]);
    const out = buildBotRecentMessagesSection({
      accountId: "a",
      target: "group:1",
      inboundLooksLikeRecall: false,
      isReplyToBot: true,
    });
    expect(out!.mode).toBe("detail");
  });

  it("filters out rows older than 24h even when newer rows exist", () => {
    const now = Date.now();
    mockQuerySentMessages.mockReturnValue([
      { target: "g:1", from: "a", messageid: "fresh", msgseqid: "", digest: "fresh", sentAt: now },
      {
        target: "g:1",
        from: "a",
        messageid: "stale",
        msgseqid: "",
        digest: "stale",
        sentAt: now - 25 * 60 * 60 * 1000,
      },
    ]);
    const out = buildBotRecentMessagesSection({
      accountId: "a",
      target: "group:1",
      inboundLooksLikeRecall: false,
      isReplyToBot: false,
    });
    expect(out!.text).toContain("messageId=fresh");
    expect(out!.text).not.toContain("messageId=stale");
  });

  it("swallows store query errors silently", () => {
    mockQuerySentMessages.mockImplementation(() => {
      throw new Error("DB error");
    });
    expect(
      buildBotRecentMessagesSection({
        accountId: "a",
        target: "group:1",
        inboundLooksLikeRecall: false,
        isReplyToBot: false,
      }),
    ).toBeUndefined();
  });
});
