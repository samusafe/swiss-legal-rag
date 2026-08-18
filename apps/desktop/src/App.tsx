import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { ArticleDocModal } from "./components/ArticleDocModal";
import { Composer } from "./components/Composer";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { SearchPalette } from "./components/SearchPalette";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { SourcesPanel } from "./components/SourcesPanel";
import { t, toSearchLang, useLang } from "./i18n";
import type { Citation, SearchResult, Source } from "./lib/api";
import { useChat } from "./hooks/useChat";
import type { ChatMessage } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { useHealth } from "./hooks/useHealth";
import { useIngest } from "./hooks/useIngest";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useShortcuts } from "./hooks/useShortcuts";
import { useTheme } from "./hooks/useTheme";
import { dedupe, toArticleRef } from "./lib/sources";
import type { ArticleRef } from "./lib/sources";
import { prefs } from "./lib/prefs";
import { logAudit } from "./lib/audit";

type Panels = { left: boolean; right: boolean };
const DEFAULT_PANELS: Panels = { left: true, right: true };

export default function App() {
  const online = useHealth();
  const { lang } = useLang();
  const { theme, setTheme } = useTheme();
  const ingest = useIngest();
  const conversations = useConversations();
  // Surfaces failures from conversation mutations that bypass useChat's own
  // banner (rename/delete, and the sidebar-list refresh triggered on
  // conversation creation — a mutation useChat makes outside
  // useConversations' own tracking) — kept separate from useChat's banner so
  // a hiccup here never overwrites a legitimate streaming error still on
  // screen.
  const [convError, setConvError] = useState<string | null>(null);
  const handleConvError = useCallback((error: unknown) => {
    setConvError(error instanceof Error ? error.message : String(error));
  }, []);
  // useChat owns conversation persistence directly (see its module doc), so
  // the sidebar's separate conversation list only learns about a new row by
  // re-reading it — fired the moment the row is INSERTED (not when the
  // whole turn, streaming included, finishes), so a brand-new conversation
  // appears in the sidebar immediately instead of only once its first
  // answer completes.
  const handleConversationCreated = useCallback(() => {
    conversations.refresh().catch(handleConvError);
  }, [conversations, handleConvError]);
  const {
    messages,
    sources,
    thinking,
    streaming,
    banner,
    conversationId,
    generatingId,
    unreadOutcomes,
    send,
    stop,
    reset,
    loadConversation,
    notifyDeleted,
  } = useChat(handleConversationCreated);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panels, setPanels] = useState<Panels>(() => prefs.get("panels", DEFAULT_PANELS));
  const [activeId, setActiveId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    prefs.set("panels", panels);
  }, [panels]);

  // useChat owns conversation persistence directly (see its module doc), so
  // the sidebar's separate conversation list only learns about a new/updated
  // row by re-reading it — and only learns which row is active by mirroring
  // useChat's own id.
  useEffect(() => {
    setActiveId(conversationId);
  }, [conversationId]);

  const toggleLeft = useCallback(() => setPanels((prev) => ({ ...prev, left: !prev.left })), []);
  const toggleRight = useCallback(
    () => setPanels((prev) => ({ ...prev, right: !prev.right })),
    [],
  );

  const ingestPercent =
    ingest.progress !== null && ingest.progress.total > 0
      ? Math.round((100 * ingest.progress.done) / ingest.progress.total)
      : null;
  const corpusEmpty = ingest.status !== null && ingest.status.chunksEmbedded === 0;
  const last = messages.at(-1);
  const latestCitations = last !== undefined && last.role === "assistant" ? last.citations : [];

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selected = selectedIndex !== null ? messages[selectedIndex] : undefined;
  const panelSources = selected !== undefined ? (selected.sources ?? []) : sources;
  const panelCitations = selected !== undefined ? selected.citations : latestCitations;
  const answerOrdinal =
    selectedIndex !== null
      ? messages.slice(0, selectedIndex + 1).filter((m) => m.role === "assistant").length
      : 0;
  const subtitle =
    selectedIndex !== null ? t("sources.answerN", { n: answerOrdinal }) : t("sources.latest");

  // Bumped every time handleNew fires (the "+" button or Ctrl+N) so the
  // composer moves focus there — otherwise a fresh app gives zero visible
  // feedback (the conversation row is only created on first message).
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);

  const handleNew = useCallback(() => {
    setSelectedIndex(null);
    reset();
    setComposerFocusSignal((n) => n + 1);
  }, [reset]);

  const handleResume = useCallback(
    (id: string) => {
      setSelectedIndex(null);
      void loadConversation(id);
    },
    [loadConversation],
  );

  const [articleTarget, setArticleTarget] = useState<{
    refs: ArticleRef[];
    index: number;
  } | null>(null);

  const handleOpenSource = useCallback((list: Source[], index: number) => {
    const source = list[index];
    const opened = toArticleRef(source);
    logAudit("article.open", { ...opened, collection: source.collection, origin: "card" });
    setArticleTarget({ refs: list.map(toArticleRef), index });
  }, []);

  const handleOpenCitation = useCallback((citation: Citation, message: ChatMessage) => {
    const list = dedupe(message.sources ?? []);
    const index = list.findIndex(
      (s) =>
        s.collection === citation.collection &&
        s.number === citation.number &&
        s.article.toLowerCase() === citation.article.toLowerCase(),
    );
    if (index === -1) return; // resolved citations always match, but stay safe
    const source = list[index];
    const opened = toArticleRef(source);
    logAudit("article.open", { ...opened, collection: source.collection, origin: "chip" });
    setArticleTarget({ refs: list.map(toArticleRef), index });
  }, []);

  const handleSearchSelect = useCallback(
    (results: SearchResult[], index: number) => {
      // Results may repeat an article (split parts); keep the first occurrence
      // per (jurisdiction, number, article) and point the modal at the
      // clicked one's slot.
      const searchLang = toSearchLang(lang);
      const refs: ArticleRef[] = [];
      const slotByKey = new Map<string, number>();
      let targetIndex = 0;
      for (const [i, result] of results.entries()) {
        const key = `${result.jurisdiction}:${result.number}:${result.article.toLowerCase()}`;
        let slot = slotByKey.get(key);
        if (slot === undefined) {
          slot = refs.length;
          slotByKey.set(key, slot);
          refs.push({
            jurisdiction: result.jurisdiction,
            number: result.number,
            article: result.article,
            lang: searchLang,
          });
        }
        if (i === index) targetIndex = slot;
      }
      const opened = results[index];
      logAudit("article.open", {
        jurisdiction: opened.jurisdiction,
        collection: opened.collection,
        number: opened.number,
        article: opened.article,
        lang: searchLang,
        origin: "palette",
      });
      setArticleTarget({ refs, index: targetIndex });
    },
    [lang],
  );

  const [paletteOpen, setPaletteOpen] = useState(false);

  useShortcuts({
    "ctrl+b": toggleLeft,
    "ctrl+n": handleNew,
    "ctrl+k": () => setPaletteOpen((prev) => !prev),
    "ctrl+j": toggleRight,
    "ctrl+,": () => setSettingsOpen(true),
  });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        online={online}
        ingestPercent={ingestPercent}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => setPaletteOpen(true)}
        theme={theme}
        setTheme={setTheme}
      />
      {(banner ?? convError ?? conversations.error) !== null && (
        <div role="alert" className="bg-danger-50 px-4 py-2 text-sm text-danger">
          {banner ?? convError ?? conversations.error}
        </div>
      )}
      {corpusEmpty && !ingest.running && (
        <div className="bg-warning-50 px-4 py-2 text-sm text-warning-700">
          {t("banner.corpusEmpty")}
        </div>
      )}
      {/* Below `lg` the three zones stack: sidebar becomes an overlay/rail
          (see Sidebar's own responsive classes) instead of consuming width,
          chat is primary, and sources moves below chat with a bounded
          height. `lg+` is untouched: the original 3-column grid. */}
      <div
        className="relative flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[auto_1fr_auto]"
        data-testid="app-layout"
      >
        <Sidebar
          collapsed={!panels.left}
          onToggle={toggleLeft}
          conversations={conversations.conversations}
          activeId={activeId}
          generatingId={generatingId}
          unreadOutcomes={unreadOutcomes}
          onNew={handleNew}
          onResume={handleResume}
          onRename={(id, title) => {
            conversations.rename(id, title).catch(handleConvError);
          }}
          onDelete={(id) => {
            // notifyDeleted() only runs after a successful delete: resets
            // the view if this was the open conversation, and aborts+blocks
            // persistence if it was the one generating in the background
            // (see useChat's notifyDeleted doc).
            conversations
              .remove(id)
              .then(() => notifyDeleted(id))
              .catch(handleConvError);
          }}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            streaming={streaming}
            searching={sources.length === 0}
            thinking={thinking}
            selectedIndex={selectedIndex}
            onSelect={(i) => setSelectedIndex((prev) => (prev === i ? null : i))}
            onDeselect={() => setSelectedIndex(null)}
            onOpenCitation={handleOpenCitation}
            conversationId={conversationId}
          />
          <Composer
            // Blocked while ANY conversation is generating (the global
            // one-at-a-time rule), not just the visible one — sending from
            // elsewhere stays blocked even though `streaming` (which
            // toggles the Stop button) is scoped to the visible turn.
            disabled={generatingId !== null || !online}
            offline={!online}
            streaming={streaming}
            focusSignal={composerFocusSignal}
            onSend={(question) => {
              setSelectedIndex(null);
              setConvError(null);
              // send() persists via lib/db directly (see useChat), bypassing
              // useConversations' own refresh. A brand-new row already
              // triggers a refresh the moment it's inserted (see
              // handleConversationCreated above); this second refresh after
              // the whole turn finishes re-sorts the sidebar by the
              // conversation's final updated_at (bumped again when the
              // assistant reply is appended) so it reflects the latest
              // activity, for both new and resumed conversations. useChat
              // folds its own failures (including a failed partial-answer
              // save) into its own banner and never rejects, but this
              // `.catch` is kept as a backstop against an unhandled
              // rejection either way.
              void send(question)
                .then(() => conversations.refresh().catch(handleConvError))
                .catch(handleConvError);
            }}
            onStop={stop}
          />
        </main>
        <div
          className="relative flex max-h-56 min-h-0 overflow-y-auto lg:max-h-none lg:overflow-visible"
          data-testid="sources-column"
        >
          <motion.div
            initial={false}
            animate={{ width: panels.right ? "20rem" : "0rem" }}
            transition={{ duration: reducedMotion ? 0 : 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            {panels.right && (
              <SourcesPanel
                sources={panelSources}
                streaming={streaming && selectedIndex === null}
                citations={panelCitations}
                subtitle={subtitle}
                onOpenArticle={handleOpenSource}
                onCollapse={toggleRight}
              />
            )}
          </motion.div>
          {!panels.right && (
            <button
              type="button"
              aria-label={t("sources.expand")}
              onClick={toggleRight}
              className="flex w-6 items-center justify-center border-l border-divider text-foreground-400 hover:text-foreground"
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
            </button>
          )}
        </div>
      </div>
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        ingest={ingest}
      />
      <ArticleDocModal target={articleTarget} onClose={() => setArticleTarget(null)} />
      <SearchPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={handleSearchSelect}
      />
    </div>
  );
}
