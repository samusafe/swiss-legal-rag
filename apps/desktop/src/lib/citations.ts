import type { Citation, Source } from "./api";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "citations"; raw: string; citations: Citation[] };

/**
 * Split an answer into ordered text/citation segments. Citations sharing the
 * same `raw` (one bracket holding several references) collapse into a single
 * segment carrying all of them, replacing every occurrence of that bracket.
 */
export function splitCitations(text: string, citations: Citation[]): Segment[] {
  const byRaw = new Map<string, Citation[]>();
  for (const citation of citations) {
    const group = byRaw.get(citation.raw);
    if (group === undefined) byRaw.set(citation.raw, [citation]);
    else group.push(citation);
  }
  const segments: Segment[] = [];
  let index = 0;
  while (index < text.length) {
    let nextAt = -1;
    let nextRaw: string | null = null;
    for (const raw of byRaw.keys()) {
      const at = text.indexOf(raw, index);
      if (at !== -1 && (nextAt === -1 || at < nextAt)) {
        nextAt = at;
        nextRaw = raw;
      }
    }
    if (nextAt === -1 || nextRaw === null) {
      segments.push({ kind: "text", text: text.slice(index) });
      break;
    }
    if (nextAt > index) segments.push({ kind: "text", text: text.slice(index, nextAt) });
    const group = byRaw.get(nextRaw);
    if (group !== undefined) segments.push({ kind: "citations", raw: nextRaw, citations: group });
    index = nextAt + nextRaw.length;
  }
  return segments;
}

// Mirrors the backend's bracket/ref two-level parsing (see
// apps/retrieval/retrieval/citations.py): brackets first, then each
// "SR <nr> Art. <id>" reference inside — prose brackets carry no refs.
const BRACKET_RE = /\[([^\]]+)\]/g;
const REF_RE = /SR\s+([\d.]+)\s+Art\.\s*([\w.]+)/g;

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
  const seenRaws = new Set<string>();
  for (const bracket of text.matchAll(BRACKET_RE)) {
    const raw = bracket[0];
    if (seenRaws.has(raw)) continue;
    const emitted = new Set<string>();
    for (const ref of (bracket[1] ?? "").matchAll(REF_RE)) {
      const sr = ref[1] ?? "";
      const article = ref[2] ?? "";
      const key = `${sr}:${article.toLowerCase()}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      const source = resolved.get(key);
      citations.push({
        raw,
        label: `SR ${sr} Art. ${article}`,
        sr,
        article,
        eli: source?.eli ?? null,
        resolved: source !== undefined,
      });
    }
    if (emitted.size > 0) seenRaws.add(raw);
  }
  return citations;
}
