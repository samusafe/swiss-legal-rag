import { motion } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ChatMessage } from "../hooks/useChat";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { t } from "../i18n";
import type { Citation } from "../lib/api";
import { SHOW_THINKING } from "../lib/api";
import { splitCitations } from "../lib/citations";
import { CitationChip } from "./CitationChip";

// Message entry: fade + 4px slide, 120ms — instant when the OS prefers reduced motion.
const ENTRY_OFFSET_PX = 4;
const ENTRY_DURATION_S = 0.12;

function ThinkingDots() {
  return (
    <span className="flex gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground-400"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

// The disclosure (expandable reasoning) is a debug-only feature gated by
// `expandable`, which defaults to VITE_SHOW_THINKING (see MessageList below).
// Off: a static, non-interactive dots+label indicator. On: today's expandable
// disclosure that reveals streamed model reasoning on click.
function ThinkingIndicator({
  searching,
  thinking,
  expandable,
}: {
  searching: boolean;
  thinking: string;
  expandable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((prev) => !prev);
  const label = (
    <span className="text-xs text-foreground-400">
      {searching ? "Searching articles…" : "Thinking…"}
    </span>
  );

  if (!expandable) {
    return (
      <div data-testid="thinking-indicator" className="flex items-center gap-2">
        <ThinkingDots />
        {label}
      </div>
    );
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="thinking-indicator"
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.stopPropagation();
            toggle();
          }
        }}
        className="flex cursor-pointer items-center gap-2"
      >
        <ThinkingDots />
        {label}
      </div>
      {expanded && (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-foreground-400">
          {thinking !== "" ? thinking : "No reasoning emitted by this model."}
        </p>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  searching,
  thinking,
  selectedIndex,
  onSelect,
  onDeselect,
  onOpenCitation,
  conversationId = null,
  showThinking = SHOW_THINKING,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  searching: boolean;
  thinking: string;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  // Clears the selection on a click that hits empty chat-area space — a
  // message bubble's own onClick (below) selects instead, and citation
  // chips/buttons stop propagation, so this never fires for those.
  onDeselect?: () => void;
  onOpenCitation?: (citation: Citation, message: ChatMessage) => void;
  // Identifies the open conversation so the list can jump to its newest
  // message on open/switch (see the scroll effect below) without also
  // firing on every token appended while streaming.
  conversationId?: string | null;
  // Defaults to the build-time VITE_SHOW_THINKING flag; overridable so tests
  // can exercise both states without stubbing import.meta.env.
  showThinking?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const entryMotion = {
    initial: { opacity: 0, y: reducedMotion ? 0 : ENTRY_OFFSET_PX },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reducedMotion ? 0 : ENTRY_DURATION_S },
  };

  const bottomRef = useRef<HTMLDivElement>(null);

  // Opening a conversation (mount) or switching to a different one must land
  // on its newest message, not wherever the previous conversation happened
  // to leave the scroll position — and must jump there instantly (no smooth
  // animation, which would be nauseating on a long thread). Keyed on
  // conversationId only, not `messages`, so this never fires while tokens
  // stream into the current conversation.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [conversationId]);

  const handleBackgroundClick = (event: MouseEvent<HTMLDivElement>): void => {
    // Only a click that lands on the container itself (empty chat-area
    // space) deselects — a click on a message bubble, citation chip, or
    // other control is a click on a descendant element, so target !==
    // currentTarget there and this is a no-op.
    if (event.target === event.currentTarget) onDeselect?.();
  };

  return (
    <div
      data-testid="message-list"
      onClick={handleBackgroundClick}
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      {/* Transcript is append-only, so index keys are stable. */}
      {messages.map((message, i) => {
        if (message.role === "user") {
          return (
            <motion.div
              key={i}
              {...entryMotion}
              className="max-w-[80%] self-end whitespace-pre-wrap rounded-sm bg-foreground px-4 py-2 text-background"
            >
              {message.text}
            </motion.div>
          );
        }

        const isStreamingThinking =
          streaming &&
          i === messages.length - 1 &&
          message.text === "" &&
          message.error === null;

        // While the thinking disclosure (its own role="button") is showing, the bubble
        // must not also be an interactive control — nested interactive elements violate
        // WAI-ARIA. Selection re-enables once the answer text exists.
        const interactiveProps = isStreamingThinking
          ? {}
          : {
              role: "button" as const,
              tabIndex: 0,
              "aria-pressed": selectedIndex === i,
              onClick: () => onSelect(i),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.key === "Enter") onSelect(i);
              },
            };

        return (
          <motion.div
            key={i}
            {...entryMotion}
            {...interactiveProps}
            className={`max-w-[80%] cursor-pointer self-start whitespace-pre-wrap rounded-sm border border-divider border-l-3 border-l-primary bg-content1 px-4 py-2 ${
              selectedIndex === i ? "ring-2 ring-primary" : ""
            }`}
          >
            {isStreamingThinking ? (
              <ThinkingIndicator
                searching={searching}
                thinking={thinking}
                expandable={showThinking}
              />
            ) : message.stopped === true && message.text.trim() === "" ? (
              // A stopped/interrupted turn that never produced any text (a
              // live Stop before the first token, or — most commonly — a
              // conversation reloaded from storage whose assistant row was
              // left empty because the app died mid-generation): show a note
              // instead of a blank bubble, rather than the citation split
              // below rendering nothing at all.
              <span className="italic text-foreground-400">{t("chat.interrupted")}</span>
            ) : (
              splitCitations(message.text, message.citations).map((segment, j) =>
                segment.kind === "text" ? (
                  <span key={j}>{segment.text}</span>
                ) : (
                  segment.citations.map((citation, k) => (
                    <CitationChip
                      key={`${j}-${k}`}
                      citation={citation}
                      onOpen={
                        onOpenCitation === undefined
                          ? undefined
                          : (c) => onOpenCitation(c, message)
                      }
                    />
                  ))
                ),
              )
            )}
            {message.error !== null && (
              <p className="mt-2 text-sm text-danger">{message.error}</p>
            )}
            {message.stopped === true && message.text.trim() !== "" && (
              <p className="mt-1 text-xs text-foreground-400">stopped</p>
            )}
          </motion.div>
        );
      })}
      {/* Scroll target for the effect above; pointer-events-none so a click
          in the space below the last message still lands on the container
          itself (and deselects) rather than on this sentinel. */}
      <div ref={bottomRef} aria-hidden="true" className="pointer-events-none h-0" />
    </div>
  );
}
