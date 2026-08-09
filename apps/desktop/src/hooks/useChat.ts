import { useCallback, useEffect, useRef, useState } from "react";
import { postChat } from "../lib/api";
import type { Citation, Source } from "../lib/api";
import { appendMessage, createConversation, getMessages } from "../lib/db";
import { extractCitations } from "../lib/citations";
import { t } from "../i18n";
import { prefs } from "../lib/prefs";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  error: string | null;
  stopped?: boolean;
  sources?: Source[];
}

function firstLine(text: string): string {
  const [line = ""] = text.split("\n");
  return line;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only relevant while the window is backgrounded — a user watching the chat
// already sees the answer land, no need to also notify them. Dynamically
// imported so jsdom tests (document.hidden is always false there) never load
// the real Tauri plugin.
async function notifyCompletion(answer: string): Promise<void> {
  if (!prefs.get("notify", true) || !document.hidden) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title: t("app.title"), body: firstLine(answer) });
  } catch (error) {
    console.error("failed to send completion notification", error);
  }
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
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors `conversationId` state so send() (a stable [] callback) always
  // reads the latest value instead of a stale closure.
  const conversationIdRef = useRef<string | null>(null);
  // Bumped by every send()/reset()/loadConversation() call. A send() in
  // flight captures the value at its start; if reset()/loadConversation()
  // (or a second send) bumps it before the stream finishes, the original
  // send's remaining state updates become no-ops instead of clobbering
  // whatever the newer operation put on screen (e.g. a conversation switched
  // to mid-stream).
  const generationRef = useRef(0);

  const setConvId = useCallback((id: string | null): void => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (question: string): Promise<void> => {
      if (abortRef.current !== null) return; // one in-flight request at a time
      const generation = ++generationRef.current;
      const isCurrent = () => generationRef.current === generation;
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
      // Hoisted above the try so both catch branches below (stopped by the
      // user, or the stream threw) can still persist whatever partial answer
      // had streamed in — the stored transcript must never diverge from
      // what's left on screen (a stopped/errored turn with visible text but
      // no saved reply, orphaning the just-saved user question).
      let convId = conversationIdRef.current;
      let finalText = "";
      let finalSources: Source[] = [];
      // Persists the assistant reply at most once per turn, whichever path
      // gets there first (clean completion below, or the catch block on stop
      // /throw) — without this guard, a failing clean-completion save would
      // fall into the catch block and retry the identical write a second
      // time for no benefit (see the `else` branch's call below).
      let answerPersisted = false;
      async function persistAnswer(): Promise<void> {
        if (answerPersisted || convId === null) return;
        answerPersisted = true;
        await appendMessage({
          conversationId: convId,
          role: "assistant",
          content: finalText,
          sourcesJson: JSON.stringify(finalSources),
        });
      }
      // Used by the catch block only (stop / mid-stream throw): unlike a
      // clean completion, which always persists whatever it has, a
      // stopped/errored turn with nothing streamed yet should leave no
      // empty assistant row behind.
      async function persistPartialAnswer(): Promise<void> {
        if (finalText === "") return;
        await persistAnswer();
      }
      try {
        if (convId === null) {
          const conversation = await createConversation(question.slice(0, 60));
          if (!isCurrent()) return; // superseded while awaiting the DB write
          convId = conversation.id;
          setConvId(convId);
        }
        await appendMessage({
          conversationId: convId,
          role: "user",
          content: question,
          sourcesJson: null,
        });
        if (!isCurrent()) return;

        let hadError = false;
        for await (const event of postChat(question, controller.signal)) {
          if (!isCurrent()) break; // superseded mid-stream: stop applying/consuming
          switch (event.type) {
            case "sources":
              finalSources = event.sources;
              setSources(event.sources);
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, sources: event.sources })),
              );
              break;
            case "thinking":
              setThinking((prev) => prev + event.delta);
              break;
            case "token":
              finalText += event.delta;
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
              hadError = true;
              setMessages((prev) =>
                updateLast(prev, (m) => ({ ...m, error: event.detail })),
              );
              break;
          }
        }
        if (!isCurrent()) return;
        // Stream finished without being stopped or thrown: persist the
        // completed turn once (not per-chunk). A failure here falls through
        // to the catch block below like any other thrown error.
        await persistAnswer();
        // An in-band `error` event still falls through this same
        // persistence path (see the switch above) — only notify on a
        // genuinely clean completion, not a stream that ended with an error.
        if (!hadError) void notifyCompletion(finalText);
      } catch (error) {
        if (!isCurrent()) return; // superseded: the error belongs to an abandoned turn
        if (controller.signal.aborted) {
          // Stopped by the user: keep the partial text on screen, no banner —
          // but still persist it (if any), so reopening the conversation
          // never shows a saved question with no reply. A failed save must
          // still reach the user (spec §7 fail loud) rather than rejecting
          // send() itself as an unhandled promise — caught locally and
          // folded into the same banner the mid-stream-error path below
          // uses, so App's single alert box shows it either way.
          setMessages((prev) => updateLast(prev, (m) => ({ ...m, stopped: true })));
          await persistPartialAnswer().catch((persistError: unknown) => {
            setBanner(errorMessage(persistError));
          });
        } else {
          const message = errorMessage(error);
          // Nothing streamed yet: drop the empty assistant bubble; the banner
          // carries the failure. Mid-stream drops keep their partial text on
          // screen and in storage.
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last !== undefined && last.role === "assistant" && last.text === "") {
              return prev.slice(0, -1);
            }
            return updateLast(prev, (m) => ({ ...m, error: message }));
          });
          setBanner(message);
          // If `error` above was itself the persist failure (thrown by the
          // clean-completion save), persistAnswer() already marked itself
          // attempted and persistPartialAnswer() below no-ops instead of
          // retrying the same write.
          await persistPartialAnswer().catch((persistError: unknown) => {
            setBanner(errorMessage(persistError));
          });
        }
      } finally {
        if (isCurrent()) {
          setStreaming(false);
          abortRef.current = null;
        }
      }
    },
    [setConvId],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Clears the chat back to a blank slate without writing a conversation row —
  // a row only appears once the first message is actually sent.
  const reset = useCallback((): void => {
    generationRef.current += 1; // invalidate any in-flight send()
    abortRef.current?.abort();
    abortRef.current = null;
    setConvId(null);
    setMessages([]);
    setSources([]);
    setThinking("");
    setBanner(null);
    setStreaming(false);
  }, [setConvId]);

  const loadConversation = useCallback(
    async (id: string): Promise<void> => {
      const generation = ++generationRef.current; // invalidate any in-flight send()
      abortRef.current?.abort();
      abortRef.current = null;
      try {
        const stored = await getMessages(id);
        if (generationRef.current !== generation) return; // superseded while loading
        const rebuilt: ChatMessage[] = stored.map((m) => {
          const msgSources: Source[] | undefined =
            m.sourcesJson !== null ? (JSON.parse(m.sourcesJson) as Source[]) : undefined;
          return {
            role: m.role,
            text: m.content,
            error: null,
            citations: m.role === "assistant" ? extractCitations(m.content, msgSources ?? []) : [],
            sources: msgSources,
          };
        });
        setConvId(id);
        setMessages(rebuilt);
        const lastAssistant = [...rebuilt].reverse().find((m) => m.role === "assistant");
        setSources(lastAssistant?.sources ?? []);
        setThinking("");
        setBanner(null);
        setStreaming(false);
      } catch (error) {
        if (generationRef.current !== generation) return;
        setBanner(errorMessage(error));
      }
    },
    [setConvId],
  );

  return {
    messages,
    sources,
    thinking,
    streaming,
    banner,
    conversationId,
    send,
    stop,
    reset,
    loadConversation,
  };
}
