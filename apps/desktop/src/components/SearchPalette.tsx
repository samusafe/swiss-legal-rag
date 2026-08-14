import { Input, Modal, ModalBody, ModalContent, Spinner } from "@heroui/react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { search } from "../lib/api";
import type { SearchResult } from "../lib/api";
import { t, toSearchLang, useLang } from "../i18n";
import { logAudit } from "../lib/audit";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_K = 8;

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function SearchResultRow({
  result,
  maxScore,
  selected,
  onSelect,
  onHover,
}: {
  result: SearchResult;
  maxScore: number;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const percent = maxScore > 0 ? Math.max(4, Math.round((result.score / maxScore) * 100)) : 0;
  const snippet = (result.context ?? result.text).slice(0, 140);

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`flex w-full cursor-pointer flex-col gap-1 rounded px-3 py-2 text-left ${
        selected ? "bg-content2" : "hover:bg-content2"
      }`}
    >
      <span className="text-xs font-semibold text-foreground-500">
        {result.collection} {result.number} · Art. {result.article}
      </span>
      {result.heading !== null && (
        <span className="text-xs text-foreground-400">{result.heading}</span>
      )}
      <span className="line-clamp-2 text-sm text-foreground">{snippet}</span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-content2">
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </button>
  );
}

export interface SearchPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (results: SearchResult[], index: number) => void;
}

/** Spotlight-style command palette over the corpus search endpoint —
 * replaces the old sidebar search field, reachable from anywhere via the
 * header trigger or Ctrl+K. */
export function SearchPalette({ isOpen, onClose, onSelect }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { lang } = useLang();
  const trimmedQuery = query.trim();

  // Full reset on close so reopening the palette never shows a stale query
  // or stale results from the previous search.
  useEffect(() => {
    if (isOpen) return;
    setQuery("");
    setResults([]);
    setSearching(false);
    setSearchError(false);
    setSelectedIndex(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (trimmedQuery === "") {
      setResults([]);
      setSearching(false);
      setSearchError(false);
      setSelectedIndex(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(false);
      const searchStart = performance.now();
      search(trimmedQuery, SEARCH_K, toSearchLang(lang), controller.signal)
        .then((found) => {
          setResults(found);
          setSearching(false);
          setSelectedIndex(found.length > 0 ? 0 : null);
          logAudit(
            "search.query",
            { query: trimmedQuery, lang: toSearchLang(lang), results: found.length },
            Math.round(performance.now() - searchStart),
          );
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults([]);
          setSearching(false);
          setSearchError(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery, lang, isOpen]);

  const maxScore = results.reduce((max, r) => Math.max(max, r.score), 0);

  function handleSelect(index: number): void {
    onClose();
    onSelect(results, index);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      if (results.length === 0) return;
      event.preventDefault();
      setSelectedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, results.length - 1)));
    } else if (event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      setSelectedIndex((prev) => (prev === null ? 0 : Math.max(prev - 1, 0)));
    } else if (event.key === "Enter") {
      const targetIndex = selectedIndex ?? 0;
      if (results[targetIndex] === undefined) return;
      event.preventDefault();
      handleSelect(targetIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      placement="top-center"
      backdrop="blur"
      size="xl"
      classNames={{ wrapper: "items-start", base: "mt-16" }}
    >
      <ModalContent>
        <ModalBody className="gap-0 p-0">
          <div className="border-b border-divider p-3">
            <Input
              autoFocus
              size="lg"
              variant="flat"
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              value={query}
              onValueChange={setQuery}
              onKeyDown={handleKeyDown}
              startContent={<SearchIcon />}
            />
          </div>
          <div className="max-h-96 min-h-24 overflow-y-auto p-2">
            {trimmedQuery === "" && (
              <p className="px-2 py-8 text-center text-sm text-foreground-400">
                {t("search.hint")}
              </p>
            )}
            {trimmedQuery !== "" && searching && (
              <div
                role="status"
                className="flex flex-col items-center gap-2 px-2 py-8 text-sm text-foreground-400"
              >
                <Spinner size="sm" />
                <span>{t("search.searching")}</span>
              </div>
            )}
            {trimmedQuery !== "" && !searching && searchError && (
              <p role="alert" className="px-2 py-8 text-center text-sm text-danger">
                {t("search.error")}
              </p>
            )}
            {trimmedQuery !== "" && !searching && !searchError && results.length === 0 && (
              <p className="px-2 py-8 text-center text-sm text-foreground-400">
                {t("search.empty")}
              </p>
            )}
            {trimmedQuery !== "" && !searching && !searchError && results.length > 0 && (
              <ul role="listbox" aria-label={t("search.placeholder")} className="flex flex-col gap-0.5">
                {results.map((result, i) => (
                  <li key={`${result.jurisdiction}-${result.number}-${result.article}-${i}`} role="option" aria-selected={i === selectedIndex}>
                    <SearchResultRow
                      result={result}
                      maxScore={maxScore}
                      selected={i === selectedIndex}
                      onSelect={() => handleSelect(i)}
                      onHover={() => setSelectedIndex(i)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
