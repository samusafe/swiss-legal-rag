import { describe, expect, it } from "vitest";
import type { Citation, Source } from "./api";
import { extractCitations, splitCitations } from "./citations";

function citation(raw: string, resolved = true): Citation {
  return {
    raw,
    label: "SR 220 Art. 335c",
    sr: "220",
    article: "335c",
    eli: resolved ? "https://example.test/e" : null,
    resolved,
  };
}

function source(
  sr: string,
  article: string,
  overrides: Partial<Source> = {},
): Source {
  return {
    sr,
    article,
    heading: null,
    eli: `https://example.test/${sr}-${article}-${overrides.lang ?? "de"}`,
    lang: "de",
    score: 0.9,
    ...overrides,
  };
}

describe("splitCitations", () => {
  it("splits text around a citation", () => {
    const c = citation("[SR 220 Art. 335c]");
    expect(splitCitations("See [SR 220 Art. 335c] here.", [c])).toEqual([
      { kind: "text", text: "See " },
      { kind: "citations", raw: "[SR 220 Art. 335c]", citations: [c] },
      { kind: "text", text: " here." },
    ]);
  });

  it("keeps unresolved citations as citation segments", () => {
    const c = citation("[SR 210 Art. 1]", false);
    expect(splitCitations("A [SR 210 Art. 1] B", [c])).toEqual([
      { kind: "text", text: "A " },
      { kind: "citations", raw: "[SR 210 Art. 1]", citations: [c] },
      { kind: "text", text: " B" },
    ]);
  });

  it("splits every occurrence of a repeated raw", () => {
    const c = citation("[SR 220 Art. 335c]");
    const segments = splitCitations("[SR 220 Art. 335c] und [SR 220 Art. 335c]", [c]);
    expect(segments).toEqual([
      { kind: "citations", raw: "[SR 220 Art. 335c]", citations: [c] },
      { kind: "text", text: " und " },
      { kind: "citations", raw: "[SR 220 Art. 335c]", citations: [c] },
    ]);
  });

  it("handles citations at the string edges", () => {
    const c = citation("[SR 220 Art. 335c]");
    expect(splitCitations("[SR 220 Art. 335c]", [c])).toEqual([
      { kind: "citations", raw: "[SR 220 Art. 335c]", citations: [c] },
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

// Mirrors apps/retrieval/tests/test_citations.py — same fixture shape, same
// scenarios, since extractCitations() is a client-side port of the backend's
// extract_citations()/_resolve_by_key().
describe("extractCitations", () => {
  it("extracts and resolves a citation", () => {
    const s = source("220", "335c");
    const citations = extractCitations("Die Frist beträgt einen Monat [SR 220 Art. 335c].", [s]);
    expect(citations).toEqual([
      {
        raw: "[SR 220 Art. 335c]",
        label: "SR 220 Art. 335c",
        sr: "220",
        article: "335c",
        eli: s.eli,
        resolved: true,
      },
    ]);
  });

  it("leaves an unknown citation unresolved", () => {
    const citations = extractCitations("Siehe [SR 999 Art. 1].", [source("220", "1")]);
    expect(citations[0]).toMatchObject({ resolved: false, eli: null });
  });

  it("collapses duplicate citations, ordered by first appearance", () => {
    const sources = [source("220", "1"), source("220", "2")];
    const answer = "A [SR 220 Art. 2]. B [SR 220 Art. 1]. C [SR 220 Art. 2].";
    expect(extractCitations(answer, sources).map((c) => c.article)).toEqual(["2", "1"]);
  });

  it("matches article numbers case-insensitively", () => {
    const citations = extractCitations("[SR 220 Art. 335C]", [source("220", "335c")]);
    expect(citations[0]?.resolved).toBe(true);
  });

  it("returns no citations for a refusal answer", () => {
    expect(extractCitations("Ich kann diese Frage nicht beantworten.", [])).toEqual([]);
  });

  it("resolves a dotted SR number", () => {
    const citations = extractCitations("[SR 142.20 Art. 5]", [source("142.20", "5")]);
    expect(citations[0]?.resolved).toBe(true);
  });

  it("resolves a letter-suffixed article", () => {
    const citations = extractCitations("[SR 220 Art. 219a]", [source("220", "219a")]);
    expect(citations[0]?.resolved).toBe(true);
  });

  it("resolves to the source matching the answer language", () => {
    const de = source("220", "1", { lang: "de", score: 0.5 });
    const fr = source("220", "1", { lang: "fr", score: 0.2 });
    const citations = extractCitations("[SR 220 Art. 1]", [de, fr], "fr");
    expect(citations[0]?.eli).toBe(fr.eli);
  });

  it("falls back to the best-scored source when no source matches the answer language", () => {
    const de = source("220", "1", { lang: "de", score: 0.5 });
    const fr = source("220", "1", { lang: "fr", score: 0.2 });
    const citations = extractCitations("[SR 220 Art. 1]", [de, fr], "it");
    expect(citations[0]?.eli).toBe(de.eli);
  });

  it("falls back to the best-scored source when the answer language is unknown", () => {
    const low = source("220", "1", { lang: "de", score: 0.1 });
    const high = source("220", "1", { lang: "fr", score: 0.7 });
    const citations = extractCitations("[SR 220 Art. 1]", [low, high]);
    expect(citations[0]?.eli).toBe(high.eli);
  });

  it("parses multi-ref brackets into one citation per ref", () => {
    const sources = [
      source("822.11", "9", { lang: "fr", score: 0.9 }),
      source("822.11", "12", { lang: "fr", score: 0.8 }),
    ];
    const citations = extractCitations(
      "Max 45h [SR 822.11 Art. 9, SR 822.11 Art. 12].",
      sources,
      "fr",
    );
    expect(citations.map((c) => c.label)).toEqual(["SR 822.11 Art. 9", "SR 822.11 Art. 12"]);
    expect(new Set(citations.map((c) => c.raw)).size).toBe(1);
    expect(citations.every((c) => c.resolved)).toBe(true);
  });

  it("ignores prose brackets", () => {
    expect(extractCitations("A note [see above].", [], null)).toEqual([]);
  });
});

describe("splitCitations multi-ref", () => {
  it("emits one segment per bracket carrying all refs", () => {
    const citations = extractCitations(
      "See [SR 822.11 Art. 9, SR 822.11 Art. 12] ok.",
      [],
      null,
    );
    const segments = splitCitations("See [SR 822.11 Art. 9, SR 822.11 Art. 12] ok.", citations);
    expect(segments).toHaveLength(3);
    const middle = segments[1];
    expect(middle.kind).toBe("citations");
    if (middle.kind === "citations") expect(middle.citations).toHaveLength(2);
  });
});
