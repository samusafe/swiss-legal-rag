import type { ChatMessage } from "../hooks/useChat";
import { splitCitations } from "../lib/citations";
import { CitationChip } from "./CitationChip";

function ThinkingIndicator({ searching }: { searching: boolean }) {
  return (
    <div className="flex items-center gap-2" data-testid="thinking-indicator">
      <span className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground-400"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="text-xs text-foreground-400">
        {searching ? "Searching articles…" : "Thinking…"}
      </span>
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  searching,
  selectedIndex,
  onSelect,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  searching: boolean;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {/* Transcript is append-only, so index keys are stable. */}
      {messages.map((message, i) =>
        message.role === "user" ? (
          <div
            key={i}
            className="max-w-[80%] self-end whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-primary-foreground"
          >
            {message.text}
          </div>
        ) : (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={selectedIndex === i}
            onClick={() => onSelect(i)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSelect(i);
            }}
            className={`max-w-[80%] cursor-pointer self-start whitespace-pre-wrap rounded-2xl bg-content2 px-4 py-2 ${
              selectedIndex === i ? "ring-2 ring-primary" : ""
            }`}
          >
            {streaming &&
            i === messages.length - 1 &&
            message.text === "" &&
            message.error === null ? (
              <ThinkingIndicator searching={searching} />
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
        ),
      )}
    </div>
  );
}
