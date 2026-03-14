import { describe, expect, it } from "vitest";
import { parseMarkdownForLocalImages } from "./markdown-local-images.js";

describe("parseMarkdownForLocalImages", () => {
  it("returns single text segment when no local image", () => {
    expect(parseMarkdownForLocalImages("hello world")).toEqual([
      { type: "text", content: "hello world" },
    ]);
  });

  it("returns single text segment when markdown image is http URL", () => {
    expect(parseMarkdownForLocalImages("see ![x](https://example.com/a.png)")).toEqual([
      { type: "text", content: "see ![x](https://example.com/a.png)" },
    ]);
  });

  it("splits text + local image + text into three segments", () => {
    const out = parseMarkdownForLocalImages("intro\n![img](/path/to.png)\noutro");
    expect(out).toEqual([
      { type: "text", content: "intro\n" },
      { type: "image", content: "/path/to.png" },
      { type: "text", content: "\noutro" },
    ]);
  });

  it("treats single-line local path as one image segment", () => {
    expect(parseMarkdownForLocalImages("/tmp/photo.jpg")).toEqual([
      { type: "image", content: "/tmp/photo.jpg" },
    ]);
    expect(parseMarkdownForLocalImages("./relative.png")).toEqual([
      { type: "image", content: "./relative.png" },
    ]);
    expect(parseMarkdownForLocalImages("file:///tmp/x.png")).toEqual([
      { type: "image", content: "file:///tmp/x.png" },
    ]);
  });

  it("extracts multiple local images in order", () => {
    const out = parseMarkdownForLocalImages("a\n![i1](/p1.png)\nb\n![i2](/p2.jpg)\nc");
    expect(out).toEqual([
      { type: "text", content: "a\n" },
      { type: "image", content: "/p1.png" },
      { type: "text", content: "\nb\n" },
      { type: "image", content: "/p2.jpg" },
      { type: "text", content: "\nc" },
    ]);
  });

  it("preserves non-local image syntax in text", () => {
    const out = parseMarkdownForLocalImages(
      "local: ![a](/local.png) remote: ![b](https://x/y.png)",
    );
    expect(out).toEqual([
      { type: "text", content: "local: " },
      { type: "image", content: "/local.png" },
      { type: "text", content: " remote: ![b](https://x/y.png)" },
    ]);
  });

  it("extracts local path from markdown link [label](url) as image segment", () => {
    const out = parseMarkdownForLocalImages("[/tmp/family_login3.png](/tmp/family_login3.png)");
    expect(out).toEqual([{ type: "image", content: "/tmp/family_login3.png" }]);
  });

  it("treats backtick-wrapped local path as image segment", () => {
    const out = parseMarkdownForLocalImages("`/tmp/family_login3.png`");
    expect(out).toEqual([{ type: "image", content: "/tmp/family_login3.png" }]);
  });

  it("treats angle-bracket-wrapped local path as image segment", () => {
    const out = parseMarkdownForLocalImages("<file:///tmp/family_login3.png>");
    expect(out).toEqual([{ type: "image", content: "file:///tmp/family_login3.png" }]);
  });

  it("returns single text segment for empty or whitespace-only", () => {
    expect(parseMarkdownForLocalImages("")).toEqual([{ type: "text", content: "" }]);
    expect(parseMarkdownForLocalImages("   ").length).toBe(1);
    expect(parseMarkdownForLocalImages("   ")[0]).toMatchObject({ type: "text" });
  });

  it("recognizes ~ and ../ as local", () => {
    expect(parseMarkdownForLocalImages("~/p.png")).toEqual([{ type: "image", content: "~/p.png" }]);
    expect(parseMarkdownForLocalImages("../p.png")).toEqual([
      { type: "image", content: "../p.png" },
    ]);
  });
});
