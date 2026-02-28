import { describe, it, expect } from "vitest";
import {
  _checkBotMentioned as checkBotMentioned,
  _checkWatchMentioned as checkWatchMentioned,
  _extractMentionIds as extractMentionIds,
} from "./bot.js";

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
