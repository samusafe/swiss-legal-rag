import type { SearchLang, Source } from "./api";

// Lib-owned shape for an article lookup, keyed on (jurisdiction, number,
// article, lang) rather than the old Fedlex-only {sr, article, lang} — used
// by SourcesPanel/ArticleDocModal to identify an article across CH and
// cantonal collections alike.
export interface ArticleRef {
  jurisdiction: string;
  number: string;
  article: string;
  lang: SearchLang;
}

// Oversized articles are split into parts sharing (jurisdiction, number,
// article, lang); show one card per article, keeping the best-scored part.
export function dedupe(sources: Source[]): Source[] {
  const byKey = new Map<string, Source>();
  for (const source of sources) {
    const key = `${source.jurisdiction}-${source.number}-${source.article}-${source.lang}`;
    const existing = byKey.get(key);
    if (existing === undefined || source.score > existing.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export function toArticleRef(source: Source): ArticleRef {
  // Source.lang comes from the corpus and is always de/fr/it; the guard keeps
  // the type narrow without trusting the wire blindly.
  const lang = source.lang === "fr" || source.lang === "it" ? source.lang : "de";
  return {
    jurisdiction: source.jurisdiction,
    number: source.number,
    article: source.article,
    lang,
  };
}
