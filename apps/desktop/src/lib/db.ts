import Database from "@tauri-apps/plugin-sql";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  sourcesJson: string | null;
  createdAt: string;
};

const CREATE_CONVERSATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

// `ON DELETE CASCADE` documents intent, but SQLite ignores it unless
// `PRAGMA foreign_keys = ON` is set on the connection (not guaranteed by the
// Tauri sql plugin's defaults). deleteConversation() therefore deletes
// messages explicitly rather than relying on the FK trigger.
const CREATE_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources_json TEXT,
    created_at TEXT NOT NULL
  )
`;

// Single lazily-loaded connection, memoized as a promise so concurrent
// callers before the first resolution all await the same connect+migrate
// work instead of racing separate Database.load() calls.
let db: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (db === null) {
    db = (async () => {
      const conn = await Database.load("sqlite:conversations.db");
      await conn.execute(CREATE_CONVERSATIONS_SQL);
      await conn.execute(CREATE_MESSAGES_SQL);
      return conn;
    })();
  }
  return db;
}

export async function initDb(): Promise<void> {
  await getDb();
}

export async function listConversations(): Promise<Conversation[]> {
  const conn = await getDb();
  return conn.select<Conversation[]>(
    `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
     FROM conversations
     ORDER BY updated_at DESC`,
  );
}

export async function createConversation(title: string): Promise<Conversation> {
  const conn = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await conn.execute(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)",
    [id, title, now, now],
  );
  return { id, title, createdAt: now, updatedAt: now };
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const conn = await getDb();
  const now = new Date().toISOString();
  await conn.execute(
    "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
    [title, now, id],
  );
}

// No BEGIN/COMMIT wrapper here — and that is deliberate, not an oversight.
// tauri-plugin-sql (verified at v2.4.0, the version pinned in Cargo.lock)
// exposes only `execute`/`select` IPC commands, each of which resolves the
// named `DbPool` and calls `pool.execute(query)` / `pool.fetch_all(query)`
// straight against a `sqlx::Pool<Sqlite>` (wrapper.rs `DbPool::execute`).
// sqlx's `Executor for &Pool` acquires a *fresh pooled connection per call*,
// and the plugin gives no command to acquire-and-hold one connection across
// multiple `execute()` round-trips. So a `BEGIN` from one JS call and the
// `COMMIT`/`ROLLBACK` from a later one are not guaranteed to land on the
// same SQLite connection — under concurrent writes (e.g. deleting a
// conversation while a stream is still appending to it) one operation's
// `ROLLBACK` can hit a connection holding a *different* operation's
// uncommitted work and discard it. A fake transaction is worse than none:
// do not reintroduce BEGIN/COMMIT/ROLLBACK here without a real
// single-connection primitive from the plugin.
//
// Instead, each multi-statement write below is ordered so an interruption
// leaves a recoverable state: delete the messages (children) before the
// conversation (parent) they reference, so a partial failure leaves an
// empty conversation, not orphaned messages pointing at nothing.
export async function deleteConversation(id: string): Promise<void> {
  const conn = await getDb();
  await conn.execute("DELETE FROM messages WHERE conversation_id = $1", [id]);
  await conn.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

export async function appendMessage(
  m: Omit<StoredMessage, "id" | "createdAt">,
): Promise<void> {
  const conn = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Same no-transaction reasoning as deleteConversation() above: insert the
  // message (the data that matters) before bumping the parent conversation's
  // updated_at, so an interruption between the two leaves the message saved
  // with only a stale sort timestamp — never a lost message.
  await conn.execute(
    `INSERT INTO messages (id, conversation_id, role, content, sources_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, m.conversationId, m.role, m.content, m.sourcesJson, now],
  );
  await conn.execute("UPDATE conversations SET updated_at = $1 WHERE id = $2", [
    now,
    m.conversationId,
  ]);
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const conn = await getDb();
  return conn.select<StoredMessage[]>(
    `SELECT id, conversation_id AS conversationId, role, content,
            sources_json AS sourcesJson, created_at AS createdAt
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
}
