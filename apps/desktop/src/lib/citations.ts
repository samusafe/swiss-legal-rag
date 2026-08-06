import type { Citation } from "./api";

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
