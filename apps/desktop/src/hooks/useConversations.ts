import { useCallback, useEffect, useState } from "react";
import {
  appendMessage as dbAppendMessage,
  createConversation,
  deleteConversation,
  getMessages as dbGetMessages,
  listConversations,
  renameConversation,
} from "../lib/db";
import type { Conversation, StoredMessage } from "../lib/db";

// Thin React state wrapper over lib/db.ts. Mutations throw on failure (no
// swallowing) — callers are expected to surface errors via toast/banner.
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // The mount refresh below has no caller to throw to (it's the effect's own
  // fire-and-forget read) — expose its failure as state instead of an
  // unhandled rejection, so App can fold it into its existing error banner.
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setConversations(await listConversations());
  }, []);

  useEffect(() => {
    refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [refresh]);

  const create = useCallback(
    async (title: string): Promise<Conversation> => {
      const conversation = await createConversation(title);
      await refresh();
      return conversation;
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, title: string): Promise<void> => {
      await renameConversation(id, title);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await deleteConversation(id);
      await refresh();
    },
    [refresh],
  );

  const appendMessage = useCallback(
    async (m: Omit<StoredMessage, "id" | "createdAt">): Promise<void> => {
      await dbAppendMessage(m);
      await refresh();
    },
    [refresh],
  );

  const getMessages = useCallback(
    (conversationId: string): Promise<StoredMessage[]> => dbGetMessages(conversationId),
    [],
  );

  return { conversations, error, create, rename, remove, appendMessage, getMessages, refresh };
}
