import type { Source } from "./api";
import type { ArticleRef } from "../components/ArticleDocModal";

// Oversized articles are split into parts sharing (sr, article, lang);
// show one card per article, keeping the best-scored part.
export function dedupe(sources: Source[]): Source[] {
  const byKey = new Map<string, Source>();
  for (const source of sources) {
    const key = `${source.sr}-${source.article}-${source.lang}`;
    const existing = byKey.get(key);
    if (existing === undefined || source.score > existing.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export function toArticleRef(source: Source): ArticleRef {
  // Source.lang comes from the corpus and is always de/fr/it; the guard keeps
  // the type narrow without trusting the wire blindly.
  const lang = source.lang === "fr" || source.lang === "it" ? source.lang : "de";
  return { sr: source.sr, article: source.article, lang };
}
