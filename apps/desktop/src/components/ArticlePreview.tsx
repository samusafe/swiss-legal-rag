import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from "@heroui/react";
import { useEffect, useState, type ReactNode } from "react";
import { search } from "../lib/api";
import type { SearchLang, SearchResult } from "../lib/api";
import { openExternal } from "../lib/open";
import { t, toSearchLang, useLang } from "../i18n";

// Per-(lang, sr, article) cache of the best-matching search result, so
// reopening the same preview (or hovering the same citation twice) never
// re-hits the network. A sidebar search result click primes this cache
// directly (see primeArticlePreviewCache) since the row already carries the
// exact match — no need to re-fetch what we just fetched.
const cache = new Map<string, SearchResult | null>();

function articlePreviewKey(lang: SearchLang, srNumber: string, article: string): string {
  return `${lang}:${srNumber}:${article}`;
}

/** Seeds the cache from a result the caller already has in hand (e.g. a
 * sidebar search hit), so opening its preview is instant. */
export function primeArticlePreviewCache(lang: SearchLang, result: SearchResult): void {
  cache.set(articlePreviewKey(lang, result.sr, result.article), result);
}

function findMatch(
  results: SearchResult[],
  srNumber: string,
  article: string,
): SearchResult | null {
  return (
    results.find(
      (r) => r.sr === srNumber && r.article.toLowerCase() === article.toLowerCase(),
    ) ?? null
  );
}

interface ArticleLookup {
  loading: boolean;
  error: boolean;
  match: SearchResult | null;
}

// Fetches (or reuses the cached) best-matching chunk for (srNumber, article)
// while `active` is true. Shared by the inline Popover preview and the
// sidebar-search Modal preview below.
function useArticleLookup(srNumber: string, article: string, active: boolean): ArticleLookup {
  const { lang } = useLang();
  const searchLang = toSearchLang(lang);
  const key = articlePreviewKey(searchLang, srNumber, article);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [match, setMatch] = useState<SearchResult | null>(null);

  useEffect(() => {
    if (!active) return;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setMatch(cached);
      setError(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    search(`SR ${srNumber} Art. ${article}`, 3, searchLang)
      .then((results) => {
        if (cancelled) return;
        const found = findMatch(results, srNumber, article);
        cache.set(key, found);
        setMatch(found);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  return { loading, error, match };
}

function ArticlePreviewBody({
  srNumber,
  article,
  loading,
  error,
  match,
}: {
  srNumber: string;
  article: string;
  loading: boolean;
  error: boolean;
  match: SearchResult | null;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <span className="text-xs font-semibold text-foreground-500">
        SR {srNumber} Art. {article}
      </span>
      {loading && (
        <div role="status" aria-label={t("preview.loading")} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-full rounded" />
          <Skeleton className="h-3 w-4/5 rounded" />
          <Skeleton className="h-3 w-3/5 rounded" />
        </div>
      )}
      {!loading && error && (
        <p role="alert" className="text-sm text-danger">
          {t("search.error")}
        </p>
      )}
      {!loading && !error && (
        <p className="text-sm text-foreground">
          {match !== null ? (match.context ?? match.text) : t("search.empty")}
        </p>
      )}
      {!loading && !error && match !== null && (
        <Button
          size="sm"
          variant="flat"
          color="primary"
          className="self-start"
          onPress={() => openExternal(match.eli)}
        >
          {t("preview.fedlex")}
        </Button>
      )}
    </div>
  );
}

/** A Popover, anchored on `trigger`, previewing the best-matching chunk for
 * (srNumber, article). Fetches on open; see useArticleLookup for caching. */
export function ArticlePreview({
  srNumber,
  article,
  trigger,
}: {
  srNumber: string;
  article: string;
  trigger: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const { loading, error, match } = useArticleLookup(srNumber, article, isOpen);

  return (
    <Popover placement="top" isOpen={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger>{trigger}</PopoverTrigger>
      <PopoverContent className="max-w-96">
        <ArticlePreviewBody
          srNumber={srNumber}
          article={article}
          loading={loading}
          error={error}
          match={match}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Same preview content as ArticlePreview, in a centered Modal — used where
 * there is no natural anchor element to pop over (the sidebar search list,
 * whose rows are unmounted once the user has moved on). */
export function ArticlePreviewModal({
  target,
  onClose,
}: {
  target: { srNumber: string; article: string } | null;
  onClose: () => void;
}) {
  const isOpen = target !== null;
  const { loading, error, match } = useArticleLookup(
    target?.srNumber ?? "",
    target?.article ?? "",
    isOpen,
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="center">
      <ModalContent>
        {target !== null && (
          <ModalBody className="pb-4 pt-4">
            <ArticlePreviewBody
              srNumber={target.srNumber}
              article={target.article}
              loading={loading}
              error={error}
              match={match}
            />
          </ModalBody>
        )}
      </ModalContent>
    </Modal>
  );
}
