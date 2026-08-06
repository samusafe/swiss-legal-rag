import { describe, expect, it } from "vitest";
import type { Citation } from "./api";
import { splitCitations } from "./citations";

function citation(raw: string, resolved = true): Citation {
  return {
    raw,
    sr: "220",
    article: "335c",
    eli: resolved ? "https://example.test/e" : null,
    resolved,
  };
}

describe("splitCitations", () => {
  it("splits text around a citation", () => {
    const c = citation("[SR 220 Art. 335c]");
    expect(splitCitations("See [SR 220 Art. 335c] here.", [c])).toEqual([
      { kind: "text", text: "See " },
      { kind: "citation", citation: c },
      { kind: "text", text: " here." },
    ]);
  });

  it("keeps unresolved citations as citation segments", () => {
    const c = citation("[SR 210 Art. 1]", false);
    expect(splitCitations("A [SR 210 Art. 1] B", [c])).toEqual([
      { kind: "text", text: "A " },
      { kind: "citation", citation: c },
      { kind: "text", text: " B" },
    ]);
  });

  it("splits every occurrence of a repeated raw", () => {
    const c = citation("[SR 220 Art. 335c]");
    const segments = splitCitations("[SR 220 Art. 335c] und [SR 220 Art. 335c]", [c]);
    expect(segments).toEqual([
      { kind: "citation", citation: c },
      { kind: "text", text: " und " },
      { kind: "citation", citation: c },
    ]);
  });

  it("handles citations at the string edges", () => {
    const c = citation("[SR 220 Art. 335c]");
    expect(splitCitations("[SR 220 Art. 335c]", [c])).toEqual([
      { kind: "citation", citation: c },
    ]);
  });

  it("returns one text segment when there are no citations", () => {
    expect(splitCitations("plain answer", [])).toEqual([
      { kind: "text", text: "plain answer" },
    ]);
  });

  it("returns no segments for empty text", () => {
    expect(splitCitations("", [citation("[SR 220 Art. 335c]")])).toEqual([]);
  });
});
