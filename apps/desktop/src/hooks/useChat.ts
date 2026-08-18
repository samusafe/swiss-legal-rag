import { useCallback, useRef, useState } from "react";
import { postChat } from "../lib/api";
import type { Citation, Source } from "../lib/api";
import { appendMessage, createConversation, getMessages } from "../lib/db";
import { extractCitations } from "../lib/citations";
import { t } from "../i18n";
import { prefs } from "../lib/prefs";
import { logAudit } from "../lib/audit";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  error: string | null;
  stopped?: boolean;
  sources?: Source[];
}

// The state of the single in-flight generation, keyed to the conversation it
// belongs to. Independent of which conversation is currently visible — a
// send() keeps updating this (and eventually persists) no matter where the
// user navigates in the meantime. `convId` is only ever null for the very
// first instant of a brand-new conversation, before createConversation()
// resolves; pushLive() in send() never publishes a snapshot before it does.
interface LiveTurn {
  convId: string;
  messages: ChatMessage[];
  sources: Source[];
  thinking: string;
}

// Sidebar notification-dot state: conversations whose generation finished —
// successfully or with an error — while the user was looking at a different
// conversation (or none). Set once, at the moment the turn ends (see
// logAnswer() in send()); cleared the moment that conversation is opened
// (see loadConversation()). In-memory only, like `live` — an app restart
// clears it, matching notification (not persistence) semantics. A
// user-initiated Stop never appears here: the user already knows they
// stopped it.
export type UnreadOutcome = "done" | "error";

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

export function useChat(onConversationCreated?: (id: string) => void) {
  // The visible conversation's own state — what's shown when it is *not*
  // the one currently generating (a resumed conversation, or a blank one
  // that has never streamed anything of its own).
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [viewMessages, setViewMessagesState] = useState<ChatMessage[]>([]);
  const [viewSources, setViewSourcesState] = useState<Source[]>([]);
  // Unlike messages/sources, reasoning text is deliberately allowed to
  // linger on screen after its turn completes (cleared only when the next
  // send() starts, or a different conversation is loaded) — matches the
  // pre-backgrounding behavior of the transient `thinking` state.
  const [viewThinking, setViewThinkingState] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  // The single in-flight generation, if any — see LiveTurn above.
  const [live, setLiveState] = useState<LiveTurn | null>(null);
  // See UnreadOutcome above.
  const [unreadOutcomes, setUnreadOutcomes] = useState<Record<string, UnreadOutcome>>({});

  const abortRef = useRef<AbortController | null>(null);
  // Conversation ids whose row has been deleted from storage while a turn
  // for them was still in flight. persistAnswer()/persistPartialAnswer()
  // consult this to skip writing into a row that no longer exists — without
  // it, a background generation for a deleted conversation would still
  // INSERT its answer via appendMessage(), resurrecting an orphaned message
  // row after the user deleted the whole conversation. Entries are removed
  // once that turn's send() finishes (see the `finally` block), so this
  // never grows past the number of concurrently in-flight deletions (at
  // most one, given the single global in-flight generation).
  const deletedIdsRef = useRef<Set<string>>(new Set());
  // Mirror every piece of state a stable ([]) callback below needs to read
  // fresh (send()/loadConversation() would otherwise close over the value
  // from the render that created them).
  const conversationIdRef = useRef<string | null>(null);
  const viewMessagesRef = useRef<ChatMessage[]>([]);
  const liveRef = useRef<LiveTurn | null>(null);
  // Bumped by every reset()/loadConversation() call (a "view navigation").
  // Lets a still-pending navigation-related async step (loadConversation's
  // DB fetch, or send()'s "adopt the just-created conversation as visible")
  // notice it's been superseded by a newer one and skip touching view state
  // — unlike the old generationRef, this never aborts or no-ops a running
  // generation, only guards what the *visible* state gets updated to.
  const viewOpRef = useRef(0);

  const setConvId = useCallback((id: string | null): void => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);
  const setViewMsgs = useCallback((messages: ChatMessage[]): void => {
    viewMessagesRef.current = messages;
    setViewMessagesState(messages);
  }, []);
  const setViewSrcs = useCallback((sources: Source[]): void => {
    setViewSourcesState(sources);
  }, []);
  const setViewThink = useCallback((thinking: string): void => {
    setViewThinkingState(thinking);
  }, []);
  const setLive = useCallback((next: LiveTurn | null): void => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  // Rendering rule: the visible conversation shows the live turn's growing
  // state exactly when it *is* the one generating; any other conversation
  // (including one that isn't generating at all) shows its own loaded/view
  // state instead.
  const streaming = live !== null && live.convId === conversationId;
  const messages = streaming ? live.messages : viewMessages;
  const sources = streaming ? live.sources : viewSources;
  const thinking = streaming ? live.thinking : viewThinking;
  // For the sidebar: which conversation (if any) is generating right now,
  // regardless of what's visible.
  const generatingId = live?.convId ?? null;

  const send = useCallback(
    async (question: string): Promise<void> => {
      if (abortRef.current !== null) return; // one in-flight generation at a time, globally
      const controller = new AbortController();
      abortRef.current = controller;
      const viewOpAtStart = viewOpRef.current;
      const sendStart = performance.now();

      // The composer only ever sends from the currently visible
      // conversation, so this always targets the right transcript — even
      // before a conversation id exists (a brand-new chat) or a `live` turn
      // does. If the user navigates away before the awaits below resolve,
      // reset()/loadConversation() overwrite this with their own view.
      let convId = conversationIdRef.current;
      let liveMessages: ChatMessage[] = [
        ...viewMessagesRef.current,
        { role: "user", text: question, citations: [], error: null },
        { role: "assistant", text: "", citations: [], error: null },
      ];
      let liveSources: Source[] = [];
      let liveThinking = "";
      setViewMsgs(liveMessages);
      setViewSrcs([]);
      setViewThink("");
      setBanner(null);

      function pushLive(): void {
        if (convId === null) return; // no conversation to attach to yet
        setLive({ convId, messages: liveMessages, sources: liveSources, thinking: liveThinking });
      }
      pushLive();

      // Hoisted above the try so both catch branches below (stopped by the
      // user, or the stream threw) can still persist whatever partial answer
      // had streamed in — the stored transcript must never diverge from
      // what's left on screen (a stopped/errored turn with visible text but
      // no saved reply, orphaning the just-saved user question).
      let finalText = "";
      let finalSources: Source[] = [];
      let doneCitations: Citation[] | null = null;
      let doneModel: string | null = null;
      let answerMessageId: string | null = null;
      // Persists the assistant reply at most once per turn, whichever path
      // gets there first (clean completion below, or the catch block on stop
      // /throw) — without this guard, a failing clean-completion save would
      // fall into the catch block and retry the identical write a second
      // time for no benefit (see the `else` branch's call below).
      let answerPersisted = false;
      async function persistAnswer(): Promise<void> {
        if (answerPersisted || convId === null || deletedIdsRef.current.has(convId)) return;
        answerPersisted = true;
        answerMessageId = await appendMessage({
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
      function logAnswer(outcome: "done" | "stopped" | "failed"): void {
        logAudit(
          "chat.answer",
          {
            conversationId: convId,
            messageId: answerMessageId,
            // null on the stopped/failed paths: the SSE `done` event never
            // arrived, so there's no model to report.
            model: doneModel,
            outcome,
            refusal: outcome === "done" && (doneCitations?.length ?? 0) === 0,
            citations: doneCitations?.length ?? 0,
          },
          Math.round(performance.now() - sendStart),
        );
        // Sidebar notification dot: only for a turn that just finished while
        // the user was elsewhere (or nowhere) — never for "stopped" (a
        // user-initiated Stop needs no reminder), and never when the user was
        // already looking at this conversation (they watched it happen).
        if (outcome !== "stopped" && convId !== null && convId !== conversationIdRef.current) {
          const finishedId = convId;
          setUnreadOutcomes((prev) => ({
            ...prev,
            [finishedId]: outcome === "done" ? "done" : "error",
          }));
        }
      }
      try {
        if (convId === null) {
          const conversation = await createConversation(question.slice(0, 60));
          convId = conversation.id;
          pushLive();
          logAudit("convo.create", { conversationId: convId });
          // The row now exists in storage — let the sidebar pick it up
          // immediately rather than waiting for this whole turn (streaming
          // included) to finish. Fired regardless of whether the user has
          // navigated away in the meantime; the sidebar list isn't scoped
          // to the visible conversation.
          onConversationCreated?.(convId);
          // Adopt the new conversation as visible only if the user hasn't
          // navigated away while this awaited — otherwise the generation
          // keeps running for its own (now background) conversation,
          // surfaced via `generatingId`, without hijacking whatever the
          // user switched to in the meantime.
          if (viewOpRef.current === viewOpAtStart) setConvId(convId);
        }
        const questionId = await appendMessage({
          conversationId: convId,
          role: "user",
          content: question,
          sourcesJson: null,
        });
        logAudit("chat.question", { conversationId: convId, messageId: questionId });

        let hadError = false;
        for await (const event of postChat(question, controller.signal)) {
          switch (event.type) {
            case "sources":
              finalSources = event.sources;
              liveSources = event.sources;
              liveMessages = updateLast(liveMessages, (m) => ({ ...m, sources: event.sources }));
              pushLive();
              break;
            case "thinking":
              liveThinking += event.delta;
              pushLive();
              break;
            case "token":
              finalText += event.delta;
              liveThinking = "";
              liveMessages = updateLast(liveMessages, (m) => ({
                ...m,
                text: m.text + event.delta,
              }));
              pushLive();
              break;
            case "done": {
              doneCitations = event.citations;
              doneModel = event.model;
              // A refusal answer cites nothing — hide its sources rather than
              // leaving the last-searched articles displayed as if relevant.
              // Keyed on the backend's explicit refusal signal, NOT on
              // "no citations": an answer whose citations the model wrote in
              // a malformed format still deserves its sources on screen.
              const cleared = event.refusal;
              if (cleared) {
                finalSources = [];
                liveSources = [];
              }
              liveMessages = updateLast(liveMessages, (m) => ({
                ...m,
                citations: event.citations,
                ...(cleared ? { sources: [] } : {}),
              }));
              pushLive();
              break;
            }
            case "error":
              hadError = true;
              liveMessages = updateLast(liveMessages, (m) => ({ ...m, error: event.detail }));
              pushLive();
              break;
          }
        }
        // Stream finished without being stopped or thrown: persist the
        // completed turn once (not per-chunk). A failure here falls through
        // to the catch block below like any other thrown error. A turn that
        // ended with an in-band `error` event and no streamed text persists
        // nothing — an empty assistant row would reload as a bogus
        // "interrupted" note instead of the error the user actually saw.
        await (hadError ? persistPartialAnswer() : persistAnswer());
        logAnswer(hadError ? "failed" : "done");
        // An in-band `error` event still falls through this same
        // persistence path (see the switch above) — only notify on a
        // genuinely clean completion, not a stream that ended with an error.
        // Firing regardless of whether this conversation is currently
        // visible is deliberate: a background turn finishing is exactly
        // when a notification is most useful.
        if (!hadError) void notifyCompletion(finalText);
      } catch (error) {
        if (controller.signal.aborted) {
          // Stopped by the user: keep the partial text on screen, no banner —
          // but still persist it (if any), so reopening the conversation
          // never shows a saved question with no reply. A failed save must
          // still reach the user (spec §7 fail loud) rather than rejecting
          // send() itself as an unhandled promise — caught locally and
          // folded into the same banner the mid-stream-error path below
          // uses, so App's single alert box shows it either way.
          liveMessages = updateLast(liveMessages, (m) => ({ ...m, stopped: true }));
          pushLive();
          await persistPartialAnswer().catch((persistError: unknown) => {
            setBanner(errorMessage(persistError));
          });
          logAnswer("stopped");
        } else {
          const message = errorMessage(error);
          // Nothing streamed yet: drop the empty assistant bubble; the banner
          // carries the failure. Mid-stream drops keep their partial text on
          // screen and in storage.
          const last = liveMessages[liveMessages.length - 1];
          if (last !== undefined && last.role === "assistant" && last.text === "") {
            liveMessages = liveMessages.slice(0, -1);
          } else {
            liveMessages = updateLast(liveMessages, (m) => ({ ...m, error: message }));
          }
          pushLive();
          setBanner(message);
          // If `error` above was itself the persist failure (thrown by the
          // clean-completion save), persistAnswer() already marked itself
          // attempted and persistPartialAnswer() below no-ops instead of
          // retrying the same write.
          await persistPartialAnswer().catch((persistError: unknown) => {
            setBanner(errorMessage(persistError));
          });
          logAnswer("failed");
        }
      } finally {
        abortRef.current = null;
        if (convId !== null) deletedIdsRef.current.delete(convId);
        // If the user is still looking at this conversation, hand the final
        // content over to its view state before `live` disappears — without
        // this, clearing `live` below would make the display fall back to
        // whatever `viewMessages` held *before* this turn streamed. If the
        // user is elsewhere, leave viewMessages alone (it belongs to a
        // different conversation); a future loadConversation() re-fetches
        // this one from the DB, where the turn was just persisted above.
        if (convId === conversationIdRef.current) {
          setViewMsgs(liveMessages);
          setViewSrcs(liveSources);
          setViewThink(liveThinking);
        }
        setLive(null);
      }
    },
    [setConvId, setViewMsgs, setViewSrcs, setViewThink, setLive, onConversationCreated],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Clears the chat back to a blank slate without writing a conversation row —
  // a row only appears once the first message is actually sent. Does not
  // touch an in-flight generation: switching to a new blank chat is just
  // another navigation, and the background turn (if any) keeps running for
  // its own conversation (see the module doc on LiveTurn).
  const reset = useCallback((): void => {
    viewOpRef.current += 1;
    setConvId(null);
    setViewMsgs([]);
    setViewSrcs([]);
    setViewThink("");
    setBanner(null);
  }, [setConvId, setViewMsgs, setViewSrcs, setViewThink]);

  // Called after a conversation row has been deleted from storage (see
  // App's Sidebar delete wiring). Two independent concerns, since the
  // deleted conversation may be neither, either, or both of: the one
  // currently visible, and the one currently generating in the background:
  //  - visible: reset() the view to the blank new-chat slate instead of
  //    leaving its now-deleted messages on screen.
  //  - generating: abort its stream so a background turn doesn't keep
  //    running for a conversation that no longer exists. Marking the id in
  //    deletedIdsRef first ensures the abort's own persistPartialAnswer()
  //    (and a clean completion racing the delete) skip writing an orphaned
  //    answer into the deleted row.
  const notifyDeleted = useCallback(
    (id: string): void => {
      deletedIdsRef.current.add(id);
      if (liveRef.current?.convId === id) abortRef.current?.abort();
      if (conversationIdRef.current === id) reset();
    },
    [reset],
  );

  const loadConversation = useCallback(
    async (id: string): Promise<void> => {
      const op = ++viewOpRef.current;
      // Opening a conversation clears its notification dot, regardless of
      // which branch below serves the request (re-attach or DB fetch) and
      // regardless of whether the fetch ultimately succeeds — the user has
      // acted on it either way.
      setUnreadOutcomes((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (liveRef.current !== null && liveRef.current.convId === id) {
        // Re-attaching to the in-flight generation for this conversation —
        // it already holds the growing transcript in memory; the DB
        // snapshot would lack the still-streaming tail, so skip the fetch.
        setConvId(id);
        setBanner(null);
        return;
      }
      try {
        const stored = await getMessages(id);
        if (viewOpRef.current !== op) return; // superseded by a newer navigation
        const rebuilt: ChatMessage[] = stored.map((m) => {
          const msgSources: Source[] | undefined =
            m.sourcesJson !== null ? (JSON.parse(m.sourcesJson) as Source[]) : undefined;
          const citations =
            m.role === "assistant" ? extractCitations(m.content, msgSources ?? []) : [];
          // A persisted assistant row with empty/whitespace-only text means the
          // turn never actually completed (e.g. the app was killed
          // mid-generation, so the answer's real text was never written).
          // Reuse the same `stopped` flag a user-initiated Stop sets on a live
          // turn — MessageList already renders it distinctly, and turns it
          // into the "interrupted" note specifically when the text is empty.
          const interrupted = m.role === "assistant" && m.content.trim() === "";
          return {
            role: m.role,
            text: m.content,
            error: null,
            citations,
            // Trust the stored sources as-is: a refusal turn already persisted
            // an empty sources list (see the `done` handling above), and an
            // answer with malformed/unextractable citations must still show
            // the articles it was grounded in.
            sources: msgSources,
            ...(interrupted ? { stopped: true as const } : {}),
          };
        });
        setConvId(id);
        setViewMsgs(rebuilt);
        const lastAssistant = [...rebuilt].reverse().find((m) => m.role === "assistant");
        setViewSrcs(lastAssistant?.sources ?? []);
        setViewThink("");
        setBanner(null);
      } catch (error) {
        if (viewOpRef.current !== op) return;
        setBanner(errorMessage(error));
      }
    },
    [setConvId, setViewMsgs, setViewSrcs, setViewThink],
  );

  return {
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
  };
}
