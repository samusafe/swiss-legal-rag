import { useCallback, useEffect, useRef, useState } from "react";
import { postChat } from "../lib/api";
import type { Citation, Source } from "../lib/api";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  error: string | null;
  stopped?: boolean;
  sources?: Source[];
}

function updateLast(
  messages: ChatMessage[],
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined) return messages;
  return [...messages.slice(0, -1), update(last)];
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [thinking, setThinking] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (question: string): Promise<void> => {
      if (abortRef.current !== null) return; // one in-flight request at a time
      const controller = new AbortController();
      abortRef.current = controller;
      setBanner(null);
      setSources([]);
      setThinking("");
      setStreaming(true);
      setMessages((prev) => [
        ...prev,
        { role: "user", text: question, citations: [], error: null },
        { role: "assistant", text: "", citations: [], error: null },
      ]);
      try {
        for await (const event of postChat(question, controller.signal)) {
          switch (event.type) {
            case "sources":
              setSources(event.sources);
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, sources: event.sources })),
              );
              break;
            case "thinking":
              setThinking((prev) => prev + event.delta);
              break;
            case "token":
              setThinking("");
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, text: m.text + event.delta })),
              );
              break;
            case "done":
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, citations: event.citations })),
              );
              break;
            case "error":
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, error: event.detail })),
              );
              break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // Stopped by the user: keep the partial text, no banner.
          setMessages((prev) => updateLast(prev, (m) => ({ ...m, stopped: true })));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          // Nothing streamed yet: drop the empty assistant bubble; the banner
          // carries the failure. Mid-stream drops keep their partial text.
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last !== undefined && last.role === "assistant" && last.text === "") {
              return prev.slice(0, -1);
            }
            return updateLast(prev, (m) => ({ ...m, error: message }));
          });
          setBanner(message);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  return { messages, sources, thinking, streaming, banner, send, stop };
}
