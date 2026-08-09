import { Button, Chip, Progress, Skeleton } from "@heroui/react";
import { t } from "../i18n";
import type { Citation, Source } from "../lib/api";
import { openExternal } from "../lib/open";

// Oversized articles are split into parts sharing (sr, article, lang);
// show one card per article, keeping the best-scored part.
function dedupe(sources: Source[]): Source[] {
  const byKey = new Map<string, Source>();
  for (const source of sources) {
    const key = `${source.sr}-${source.article}-${source.lang}`;
    const existing = byKey.get(key);
    if (existing === undefined || source.score > existing.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

// Rerank scores are unbounded logits — the bar is relative to this result set.
function relativePercent(score: number, scores: number[]): number {
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (max === min) return 100;
  return Math.round((100 * (score - min)) / (max - min));
}

export function SourcesPanel({
  sources,
  streaming,
  citations,
  subtitle,
  onCollapse,
}: {
  sources: Source[];
  streaming: boolean;
  citations: Citation[];
  subtitle: string;
  onCollapse?: () => void;
}) {
  const deduped = dedupe(sources);
  const scores = deduped.map((source) => source.score);
  return (
    <aside className="flex h-full w-80 flex-col gap-2 overflow-y-auto border-l border-divider p-4">
      <div className="flex items-center gap-2">
        {onCollapse !== undefined && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("sources.collapse")}
            onPress={onCollapse}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </Button>
        )}
        <h2 className="text-sm font-semibold uppercase text-foreground-500">{t("sources.title")}</h2>
        <span className="text-xs text-foreground-400">{subtitle}</span>
        {deduped.length > 0 && (
          <Chip size="sm" variant="flat" className="ml-auto">
            {deduped.length} {deduped.length === 1 ? "article" : "articles"}
          </Chip>
        )}
      </div>
      {streaming &&
        deduped.length === 0 &&
        [0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            data-testid="source-skeleton"
            className="flex flex-1 flex-col justify-center gap-2 rounded-sm border border-divider bg-content1 p-3"
          >
            <Skeleton className="h-4 w-3/5 rounded" />
            <Skeleton className="h-3 w-4/5 rounded" />
            <Skeleton className="h-3 w-2/5 rounded" />
          </div>
        ))}
      {!streaming && deduped.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-8 w-8 text-foreground-300"
            aria-hidden="true"
          >
            <path d="M7 3h7l4 4v14H7z" />
            <path d="M14 3v4h4" />
            <path d="M9.5 12h5M9.5 15h5" />
          </svg>
          <p className="text-sm text-foreground-400">
            Ask a question to see the articles behind the answer.
          </p>
        </div>
      )}
      {deduped.map((source) => {
        // `resolved` is deliberately not checked: an unresolved citation can't match
        // any source in this list anyway.
        const cited = citations.some(
          (citation) =>
            citation.sr === source.sr &&
            citation.article.toLowerCase() === source.article.toLowerCase(),
        );
        return (
          <div
            key={`${source.sr}-${source.article}-${source.lang}`}
            className="flex flex-col gap-1.5 rounded-sm border border-divider bg-content1 p-3 text-foreground"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">
                SR {source.sr} · Art. {source.article}
              </span>
              <Chip size="sm" variant="flat">
                {source.lang.toUpperCase()}
              </Chip>
              {cited && (
                <Chip size="sm" color="success" variant="flat">
                  {t("sources.cited")}
                </Chip>
              )}
            </div>
            {source.heading !== null && (
              <p className="line-clamp-2 text-sm text-foreground-500">{source.heading}</p>
            )}
            <div
              className="flex items-center gap-2"
              title={`rerank score ${source.score.toFixed(2)}`}
            >
              <Progress
                aria-label="Relevance"
                size="sm"
                color="primary"
                value={relativePercent(source.score, scores)}
                className="max-w-24"
              />
              <span className="text-xs text-foreground-400">{source.score.toFixed(2)}</span>
            </div>
            <Button
              size="sm"
              variant="flat"
              color="primary"
              className="self-start"
              aria-label="Open on Fedlex"
              onPress={() => openExternal(source.eli)}
              endContent={
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                >
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              }
            >
              Fedlex
            </Button>
          </div>
        );
      })}
    </aside>
  );
}
