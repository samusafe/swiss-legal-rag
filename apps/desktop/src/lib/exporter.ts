import type { Conversation, StoredMessage } from "./db";
import type { Source } from "./api";
import { extractCitations } from "./citations";

// Pure string-in/string-out formatting — no I/O. Callers (SettingsModal)
// handle the save dialog and file write.

// Raw dump of the stored rows, deliberately exempt from the zero-citations
// rule below: scrubbing here would make the JSON diverge from the database.
export function toJson(conversation: Conversation, messages: StoredMessage[]): string {
  return JSON.stringify({ conversation, messages }, null, 2);
}

// Same zero-citations rule useChat's loadConversation applies (see
// useChat.ts): a stored answer that cites nothing — including refusals saved
// before this rule existed, whose sourcesJson still holds the retrieved
// articles — must not surface sources here either.
function sourcesOf(message: StoredMessage): Source[] {
  const parsed: Source[] = message.sourcesJson !== null ? (JSON.parse(message.sourcesJson) as Source[]) : [];
  if (message.role !== "assistant") return parsed;
  return extractCitations(message.content, parsed).length === 0 ? [] : parsed;
}

export function toMarkdown(conversation: Conversation, messages: StoredMessage[]): string {
  const lines: string[] = [`# ${conversation.title}`, ""];
  for (const message of messages) {
    const speaker = message.role === "user" ? "You" : "Assistant";
    lines.push(`**${speaker}:** ${message.content}`);
    if (message.role === "assistant") {
      const sources = sourcesOf(message);
      if (sources.length > 0) {
        lines.push("");
        for (const source of sources) {
          lines.push(`- SR ${source.sr} Art. ${source.article}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
