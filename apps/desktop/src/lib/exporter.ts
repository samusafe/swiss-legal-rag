import type { Conversation, StoredMessage } from "./db";
import type { Source } from "./api";

// Pure string-in/string-out formatting — no I/O. Callers (SettingsModal)
// handle the save dialog and file write.

export function toJson(conversation: Conversation, messages: StoredMessage[]): string {
  return JSON.stringify({ conversation, messages }, null, 2);
}

function sourcesOf(message: StoredMessage): Source[] {
  return message.sourcesJson !== null ? (JSON.parse(message.sourcesJson) as Source[]) : [];
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
