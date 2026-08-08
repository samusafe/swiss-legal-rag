import { useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../hooks/useChat";
import { SHOW_THINKING } from "../lib/api";
import { splitCitations } from "../lib/citations";
import { CitationChip } from "./CitationChip";

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
  showThinking = SHOW_THINKING,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  searching: boolean;
  thinking: string;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  // Defaults to the build-time VITE_SHOW_THINKING flag; overridable so tests
  // can exercise both states without stubbing import.meta.env.
  showThinking?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {/* Transcript is append-only, so index keys are stable. */}
      {messages.map((message, i) => {
        if (message.role === "user") {
          return (
            <div
              key={i}
              className="max-w-[80%] self-end whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-primary-foreground"
            >
              {message.text}
            </div>
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
          <div
            key={i}
            {...interactiveProps}
            className={`max-w-[80%] cursor-pointer self-start whitespace-pre-wrap rounded-2xl bg-content2 px-4 py-2 ${
              selectedIndex === i ? "ring-2 ring-primary" : ""
            }`}
          >
            {isStreamingThinking ? (
              <ThinkingIndicator
                searching={searching}
                thinking={thinking}
                expandable={showThinking}
              />
            ) : (
              splitCitations(message.text, message.citations).map((segment, j) =>
                segment.kind === "text" ? (
                  <span key={j}>{segment.text}</span>
                ) : (
                  <CitationChip key={j} citation={segment.citation} />
                ),
              )
            )}
            {message.error !== null && (
              <p className="mt-2 text-sm text-danger">{message.error}</p>
            )}
            {message.stopped === true && (
              <p className="mt-1 text-xs text-foreground-400">stopped</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
