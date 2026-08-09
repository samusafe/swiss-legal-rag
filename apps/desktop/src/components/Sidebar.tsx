import {
  Button,
  Input,
  Listbox,
  ListboxItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Conversation } from "../lib/db";
import { search } from "../lib/api";
import type { SearchResult } from "../lib/api";
import { t, toSearchLang, useLang } from "../i18n";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

const RAIL_WIDTH = "3rem";
const EXPANDED_WIDTH = "16rem";
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_K = 8;

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z" />
    </svg>
  );
}

// Swallows the pointerdown/click before it bubbles to the ListboxItem's own
// press handling — otherwise pressing "rename" or "delete" also fires the
// item's onAction (resuming the wrong conversation).
function stopBubble(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function RenamePopover({
  conversation,
  onRename,
}: {
  conversation: Conversation;
  onRename: (id: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(conversation.title);

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(conversation.title);
      }}
    >
      <PopoverTrigger>
        <button
          type="button"
          aria-label={t("convo.rename")}
          onPointerDown={stopBubble}
          onClick={stopBubble}
          className="rounded p-1 text-foreground-400 hover:text-foreground"
        >
          <PencilIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent onPointerDown={stopBubble} onClick={stopBubble}>
        <form
          className="flex flex-col gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = value.trim();
            if (title.length > 0) onRename(conversation.id, title);
            setOpen(false);
          }}
        >
          <Input
            size="sm"
            aria-label={t("convo.rename")}
            value={value}
            onValueChange={setValue}
            autoFocus
          />
          <Button type="submit" size="sm" color="primary">
            {t("convo.rename")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function DeletePopover({
  conversation,
  onDelete,
}: {
  conversation: Conversation;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label={t("convo.delete")}
          onPointerDown={stopBubble}
          onClick={stopBubble}
          className="rounded p-1 text-foreground-400 hover:text-danger"
        >
          <TrashIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent onPointerDown={stopBubble} onClick={stopBubble}>
        <div className="flex flex-col gap-2 p-2">
          <p className="max-w-56 text-sm">{t("convo.deleteConfirm")}</p>
          <Button
            size="sm"
            color="danger"
            className="self-end"
            onPress={() => {
              onDelete(conversation.id);
              setOpen(false);
            }}
          >
            {t("convo.delete")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SearchResultRow({
  result,
  maxScore,
  onSelect,
}: {
  result: SearchResult;
  maxScore: number;
  onSelect: () => void;
}) {
  const percent = maxScore > 0 ? Math.max(4, Math.round((result.score / maxScore) * 100)) : 0;
  const snippet = (result.context ?? result.text).slice(0, 140);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-1 rounded px-2 py-2 text-left hover:bg-content2"
    >
      <span className="text-xs font-semibold text-foreground-500">
        SR {result.sr} · Art. {result.article}
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

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onResume: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSearchSelect?: (result: SearchResult) => void;
  // Bumped by the parent on every Ctrl+K press (spec §3: "Ctrl+K focuses the
  // input") — a plain `collapsed` prop change isn't enough on its own since
  // Ctrl+K on an already-expanded sidebar wouldn't otherwise trigger anything.
  searchFocusSignal?: number;
}

export function Sidebar({
  collapsed,
  onToggle,
  conversations,
  activeId,
  onNew,
  onResume,
  onRename,
  onDelete,
  onSearchSelect,
  searchFocusSignal = 0,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const { lang } = useLang();
  const reducedMotion = usePrefersReducedMotion();
  const trimmedQuery = query.trim();
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Set by the collapsed rail's search button, which expands the panel via
  // `onToggle` first — the input isn't mounted yet at click time, so focus is
  // applied once `collapsed` actually flips (see the effect below).
  const focusOnExpandRef = useRef(false);

  useEffect(() => {
    if (searchFocusSignal === 0) return; // skip the initial mount
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchFocusSignal]);

  useEffect(() => {
    if (!collapsed && focusOnExpandRef.current) {
      focusOnExpandRef.current = false;
      searchInputRef.current?.focus();
    }
  }, [collapsed]);

  useEffect(() => {
    if (trimmedQuery === "") {
      setResults([]);
      setSearching(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(false);
      search(trimmedQuery, SEARCH_K, toSearchLang(lang), controller.signal)
        .then((found) => {
          setResults(found);
          setSearching(false);
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
  }, [trimmedQuery, lang]);

  const maxScore = results.reduce((max, r) => Math.max(max, r.score), 0);

  return (
    <motion.nav
      aria-label={t("convo.section")}
      initial={false}
      animate={{ width: collapsed ? RAIL_WIDTH : EXPANDED_WIDTH }}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: "easeOut" }}
      className="flex flex-col overflow-hidden border-r border-divider"
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 py-3">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("search.placeholder")}
            onPress={() => {
              focusOnExpandRef.current = true;
              onToggle();
            }}
          >
            <SearchIcon />
          </Button>
          <Button isIconOnly size="sm" variant="light" aria-label={t("convo.new")} onPress={onNew}>
            <PlusIcon />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("convo.section")}
            onPress={onToggle}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-center gap-1">
            <Input
              ref={searchInputRef}
              size="sm"
              placeholder={t("search.placeholder")}
              value={query}
              onValueChange={setQuery}
              onKeyDown={(event) => {
                if (event.key === "Enter" && results.length > 0) {
                  onSearchSelect?.(results[0]);
                }
              }}
              startContent={<SearchIcon />}
            />
            <Button isIconOnly size="sm" variant="light" aria-label={t("convo.new")} onPress={onNew}>
              <PlusIcon />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={t("convo.section")}
              onPress={onToggle}
            >
              <ChevronLeftIcon />
            </Button>
          </div>
          {trimmedQuery === "" ? (
            <>
              <h2 className="px-1 text-xs font-semibold uppercase text-foreground-500">
                {t("convo.section")}
              </h2>
              <Listbox
                aria-label={t("convo.section")}
                selectionMode="none"
                onAction={(key) => onResume(String(key))}
                className="min-h-0 flex-1 overflow-y-auto"
                itemClasses={{ base: "group" }}
              >
                {conversations.map((conversation) => (
                  <ListboxItem
                    key={conversation.id}
                    textValue={conversation.title || t("convo.untitled")}
                    className={
                      conversation.id === activeId
                        ? "border-l-3 border-primary"
                        : "border-l-3 border-transparent"
                    }
                    endContent={
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                        <RenamePopover conversation={conversation} onRename={onRename} />
                        <DeletePopover conversation={conversation} onDelete={onDelete} />
                      </div>
                    }
                  >
                    {conversation.title || t("convo.untitled")}
                  </ListboxItem>
                ))}
              </Listbox>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!searching && searchError && (
                <p role="alert" className="px-2 py-4 text-center text-sm text-danger">
                  {t("search.error")}
                </p>
              )}
              {!searching && !searchError && results.length === 0 && (
                <p className="px-2 py-4 text-center text-sm text-foreground-400">
                  {t("search.empty")}
                </p>
              )}
              {!searching &&
                !searchError &&
                results.map((result, i) => (
                  <SearchResultRow
                    key={`${result.sr}-${result.article}-${i}`}
                    result={result}
                    maxScore={maxScore}
                    onSelect={() => onSearchSelect?.(result)}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </motion.nav>
  );
}
