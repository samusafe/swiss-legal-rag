import type { Citation, Source } from "./api";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "citation"; citation: Citation };

/**
 * Split an answer into ordered text/citation segments by raw string match
 * against the `done` event's citations. Raws never overlap (each is a full
 * `[SR ... Art. ...]` bracket), so the earliest next occurrence wins.
 */
export function splitCitations(text: string, citations: Citation[]): Segment[] {
  const byRaw = new Map(citations.map((c) => [c.raw, c] as const));
  const segments: Segment[] = [];
  let index = 0;
  while (index < text.length) {
    let nextAt = -1;
    let nextCitation: Citation | null = null;
    for (const [raw, cite] of byRaw) {
      const at = text.indexOf(raw, index);
      if (at !== -1 && (nextAt === -1 || at < nextAt)) {
        nextAt = at;
        nextCitation = cite;
      }
    }
    if (nextAt === -1 || nextCitation === null) {
      segments.push({ kind: "text", text: text.slice(index) });
      break;
    }
    if (nextAt > index) {
      segments.push({ kind: "text", text: text.slice(index, nextAt) });
    }
    segments.push({ kind: "citation", citation: nextCitation });
    index = nextAt + nextCitation.raw.length;
  }
  return segments;
}

const CITATION_RE = /\[SR\s+([\d.]+)\s+Art\.\s*([\w.]+)\]/g;

/**
 * Mirrors the backend's extract_citations()/_resolve_by_key()
 * (apps/retrieval/retrieval/citations.py): groups sources by (sr,
 * article.lower()) — cross-lingual dense retrieval can return the same
 * article in two languages — and resolves each citation to the group's
 * source matching `answerLang` if any, else the group's highest-scored
 * source (first one wins on a tie, matching Python's `max()`).
 *
 * Used to rebuild a stored message's `Citation[]` from its persisted
 * `content` + parsed `sourcesJson`, since StoredMessage doesn't persist
 * citations directly.
 */
export function extractCitations(
  text: string,
  sources: Source[],
  answerLang?: string | null,
): Citation[] {
  const groups = new Map<string, Source[]>();
  for (const source of sources) {
    const key = `${source.sr}:${source.article.toLowerCase()}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [source]);
    else group.push(source);
  }
  const resolved = new Map<string, Source>();
  for (const [key, group] of groups) {
    const matching =
      answerLang !== undefined && answerLang !== null
        ? group.filter((s) => s.lang === answerLang)
        : [];
    const pool = matching.length > 0 ? matching : group;
    resolved.set(
      key,
      pool.reduce((best, s) => (s.score > best.score ? s : best)),
    );
  }

  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CITATION_RE)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const sr = match[1] ?? "";
    const article = match[2] ?? "";
    const source = resolved.get(`${sr}:${article.toLowerCase()}`);
    citations.push({
      raw,
      sr,
      article,
      eli: source?.eli ?? null,
      resolved: source !== undefined,
    });
  }
  return citations;
}
