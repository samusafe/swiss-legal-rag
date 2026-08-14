import { describe, expect, it } from "vitest";
import type { Source } from "./api";
import { dedupe, toArticleRef } from "./sources";

function source(overrides: Partial<Source> = {}): Source {
  return {
    jurisdiction: "ch",
    collection: "SR",
    number: "220",
    article: "1",
    heading: null,
    sourceUrl: "https://example.test/220-1",
    lang: "de",
    score: 0.5,
    citationLabel: "SR 220 Art. 1",
    ...overrides,
  };
}

describe("dedupe", () => {
  it("keeps the best-scored part per (jurisdiction, number, article, lang)", () => {
    const worse = source({ score: 0.2 });
    const better = source({ score: 0.9 });
    expect(dedupe([worse, better])).toEqual([better]);
  });

  it("treats different jurisdictions with the same number/article as distinct", () => {
    const federal = source({ jurisdiction: "ch", number: "811.1", article: "2" });
    const cantonal = source({ jurisdiction: "sg", collection: "sGS", number: "811.1", article: "2" });
    expect(dedupe([federal, cantonal])).toHaveLength(2);
  });

  it("treats different languages as distinct", () => {
    const de = source({ lang: "de", score: 0.5 });
    const fr = source({ lang: "fr", score: 0.5 });
    expect(dedupe([de, fr])).toHaveLength(2);
  });

  it("sorts the result by descending score", () => {
    const low = source({ article: "1", score: 0.1 });
    const high = source({ article: "2", score: 0.9 });
    expect(dedupe([low, high])).toEqual([high, low]);
  });
});

describe("toArticleRef", () => {
  it("projects a source down to its article reference", () => {
    const s = source({ jurisdiction: "sg", number: "811.1", article: "2", lang: "fr" });
    expect(toArticleRef(s)).toEqual({ jurisdiction: "sg", number: "811.1", article: "2", lang: "fr" });
  });

  it("narrows an unexpected lang to the de default", () => {
    const s = source({ lang: "en" });
    expect(toArticleRef(s).lang).toBe("de");
  });
});
