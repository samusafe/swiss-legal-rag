import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  Skeleton,
  Tab,
  Tabs,
} from "@heroui/react";
import { useEffect, useState } from "react";
import { ApiError, fetchArticle } from "../lib/api";
import type { Article, SearchLang } from "../lib/api";
import { openExternal } from "../lib/open";
import { logAudit } from "../lib/audit";
import { t } from "../i18n";

export interface ArticleRef {
  sr: string;
  article: string;
  lang: SearchLang;
}

const CORPUS_LANGS: readonly SearchLang[] = ["de", "fr", "it"];

// Per-(sr, article, lang) cache of full articles so revisiting one (arrows,
// language tabs) is instant. Session-lifetime bounded.
const cache = new Map<string, Article>();

interface Loaded {
  loading: boolean;
  status: number | null; // HTTP status of a failure; null while ok/loading
  article: Article | null;
}

function useArticle(ref: ArticleRef | null, lang: SearchLang | null): Loaded {
  const effectiveLang = lang ?? ref?.lang ?? "de";
  const key = ref === null ? null : `${ref.sr}:${ref.article.toLowerCase()}:${effectiveLang}`;
  const [state, setState] = useState<Loaded>({ loading: false, status: null, article: null });

  useEffect(() => {
    if (ref === null || key === null) return;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setState({ loading: false, status: null, article: cached });
      return;
    }
    const controller = new AbortController();
    setState({ loading: true, status: null, article: null });
    fetchArticle(ref.sr, ref.article, effectiveLang, controller.signal)
      .then((article) => {
        cache.set(key, article);
        setState({ loading: false, status: null, article });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(`failed to load article SR ${ref.sr} Art. ${ref.article}`, error);
        setState({
          loading: false,
          status: error instanceof ApiError ? error.status : 0,
          article: null,
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      {direction === "left" ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

/** Document-style reader for one full article, with DE/FR/IT tabs and ←/→
 * navigation across the refs it was opened with (an answer's sources, or a
 * search result list). */
export function ArticleDocModal({
  target,
  onClose,
}: {
  target: { refs: ArticleRef[]; index: number } | null;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [langTab, setLangTab] = useState<SearchLang | null>(null);

  // Re-arm position and language whenever the modal is (re)opened.
  useEffect(() => {
    setIndex(target?.index ?? 0);
    setLangTab(null);
  }, [target]);

  const refs = target?.refs ?? [];
  const ref = refs[index] ?? null;
  const { loading, status, article } = useArticle(ref, langTab);
  const shownLang = langTab ?? ref?.lang ?? "de";
  const canPrev = index > 0;
  const canNext = index < refs.length - 1;

  function goTo(next: number): void {
    setIndex(next);
    setLangTab(null); // each article opens in its own source language
  }

  const disabledLangs =
    article === null
      ? []
      : CORPUS_LANGS.filter((lang) => !article.availableLangs.includes(lang));

  return (
    <Modal
      isOpen={target !== null}
      onClose={onClose}
      size="3xl"
      scrollBehavior="inside"
      placement="center"
    >
      <ModalContent
        // The dialog container itself takes keyboard focus on open (that is
        // what makes the arrow keys work), but its focus ring reads as a
        // stray white line around the modal — hide it on the container only.
        className="outline-hidden data-[focus-visible=true]:outline-hidden"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && canPrev) goTo(index - 1);
          if (event.key === "ArrowRight" && canNext) goTo(index + 1);
        }}
      >
        {ref !== null && (
          <ModalBody className="gap-0 p-0">
            <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
              {refs.length > 1 && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={t("article.prev")}
                  isDisabled={!canPrev}
                  onPress={() => goTo(index - 1)}
                >
                  <ArrowIcon direction="left" />
                </Button>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs uppercase tracking-wide text-foreground-400">
                  {article !== null
                    ? `${article.actName} (${article.abbrev}) · SR ${article.sr}`
                    : `SR ${ref.sr}`}
                </p>
                <p className="truncate font-semibold">
                  Art. {ref.article}
                  {article?.heading != null ? ` — ${article.heading}` : ""}
                </p>
              </div>
              {refs.length > 1 && (
                <span className="text-xs tabular-nums text-foreground-400">
                  {index + 1} / {refs.length}
                </span>
              )}
              {refs.length > 1 && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={t("article.next")}
                  isDisabled={!canNext}
                  onPress={() => goTo(index + 1)}
                >
                  <ArrowIcon direction="right" />
                </Button>
              )}
              <Tabs
                size="sm"
                selectedKey={shownLang}
                disabledKeys={disabledLangs}
                onSelectionChange={(key) => {
                  logAudit("article.langSwitch", {
                    sr: ref.sr,
                    article: ref.article,
                    from: shownLang,
                    to: key as SearchLang,
                  });
                  setLangTab(key as SearchLang);
                }}
                aria-label="Language"
              >
                {CORPUS_LANGS.map((lang) => (
                  <Tab key={lang} title={lang.toUpperCase()} />
                ))}
              </Tabs>
            </div>
            <div className="max-h-[65vh] overflow-y-auto bg-content1 px-8 py-6">
              {/* Sans-serif like Fedlex itself — Swiss federal publications use
                  a clean sans, not a bookish serif. */}
              <div className="mx-auto max-w-prose text-justify text-[0.95rem] leading-7">
                {loading && (
                  <div
                    role="status"
                    aria-label={t("article.loading")}
                    className="flex flex-col gap-2"
                  >
                    <Skeleton className="h-4 w-4/5 rounded" />
                    <Skeleton className="h-4 w-full rounded" />
                    <Skeleton className="h-4 w-3/5 rounded" />
                  </div>
                )}
                {!loading && status === 404 && (
                  <p role="alert" className="text-sm text-foreground-500">
                    {t("article.notInLang")}
                  </p>
                )}
                {!loading && status !== null && status !== 404 && (
                  <p role="alert" className="text-sm text-danger">
                    {t("article.error")}
                  </p>
                )}
                {!loading &&
                  article !== null &&
                  article.texts.map((paragraph, i) => (
                    <p key={i} className="mb-4 whitespace-pre-wrap text-foreground">
                      {paragraph}
                    </p>
                  ))}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-divider px-4 py-3">
              <span className="text-xs text-foreground-400">
                {article !== null ? t("article.version", { date: article.versionDate }) : ""}
              </span>
              <Button
                size="sm"
                color="primary"
                isDisabled={article === null}
                onPress={() => {
                  if (article !== null) {
                    logAudit("article.fedlex", { sr: article.sr, article: article.article });
                    openExternal(article.eli);
                  }
                }}
              >
                {t("article.fedlex")}
              </Button>
            </div>
          </ModalBody>
        )}
      </ModalContent>
    </Modal>
  );
}
