import type { ChatMessage } from "../hooks/useChat";
import { splitCitations } from "../lib/citations";
import { CitationChip } from "./CitationChip";

export function MessageList({ messages }: { messages: ChatMessage[] }) {
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
            className="max-w-[80%] self-start whitespace-pre-wrap rounded-2xl bg-content2 px-4 py-2"
          >
            {splitCitations(message.text, message.citations).map((segment, j) =>
              segment.kind === "text" ? (
                <span key={j}>{segment.text}</span>
              ) : (
                <CitationChip key={j} citation={segment.citation} />
              ),
            )}
            {message.error !== null && (
              <p className="mt-2 text-sm text-danger">{message.error}</p>
            )}
          </div>
        ),
      )}
    </div>
  );
}
