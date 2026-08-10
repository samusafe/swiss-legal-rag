import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@tauri-apps/plugin-sql";
import type Database from "@tauri-apps/plugin-sql";

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn() },
}));

type FakeConn = {
  execute: ReturnType<typeof makeExecute>;
  select: ReturnType<typeof makeSelect>;
};

function makeExecute() {
  return vi.fn<(query: string, bindValues?: unknown[]) => Promise<QueryResult>>().mockResolvedValue(
    { rowsAffected: 1 },
  );
}

function makeSelect() {
  return vi.fn<(query: string, bindValues?: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
}

function makeConn(): FakeConn {
  return { execute: makeExecute(), select: makeSelect() };
}

/** Fresh copy of db.ts (its module-level connection cache included) per test. */
async function freshDb(conn: FakeConn) {
  vi.resetModules();
  const sql = await import("@tauri-apps/plugin-sql");
  vi.mocked(sql.default.load).mockResolvedValue(conn as unknown as Database);
  return import("./db");
}

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const FIXED_UUID = "11111111-1111-1111-1111-111111111111" as ReturnType<
  typeof crypto.randomUUID
>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
  vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_UUID);
  // All existing tests below exercise real Tauri-mode behavior.
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("db", () => {
  it("initDb() connects once and migrates both tables", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);
    const sql = await import("@tauri-apps/plugin-sql");

    await db.initDb();
    await db.initDb(); // second call: no extra connect, migrations idempotent by SQL itself

    expect(vi.mocked(sql.default.load)).toHaveBeenCalledOnce();
    expect(vi.mocked(sql.default.load)).toHaveBeenCalledWith("sqlite:conversations.db");
    expect(conn.execute).toHaveBeenCalledTimes(2);
    const [firstSql] = conn.execute.mock.calls[0] ?? [];
    const [secondSql] = conn.execute.mock.calls[1] ?? [];
    expect(firstSql).toContain("CREATE TABLE IF NOT EXISTS conversations");
    expect(secondSql).toContain("CREATE TABLE IF NOT EXISTS messages");
    expect(secondSql).toContain("REFERENCES conversations(id)");
  });

  it("listConversations() selects newest updated first", async () => {
    const conn = makeConn();
    const rows: unknown = [{ id: "a", title: "A", createdAt: FIXED_NOW, updatedAt: FIXED_NOW }];
    conn.select.mockResolvedValue(rows);
    const db = await freshDb(conn);

    const result = await db.listConversations();

    expect(result).toBe(rows);
    const [querySql] = conn.select.mock.calls[0] ?? [];
    expect(querySql).toContain("FROM conversations");
    expect(querySql).toContain("ORDER BY updated_at DESC");
  });

  it("createConversation() inserts a row and returns it", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    const result = await db.createConversation("New chat");

    expect(result).toEqual({
      id: FIXED_UUID,
      title: "New chat",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    const insertCall = conn.execute.mock.calls.find(([querySql]) =>
      querySql.includes("INSERT INTO conversations"),
    );
    expect(insertCall?.[1]).toEqual([FIXED_UUID, "New chat", FIXED_NOW, FIXED_NOW]);
  });

  it("renameConversation() updates title and bumps updated_at", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    await db.renameConversation("conv-1", "Renamed");

    const updateCall = conn.execute.mock.calls.find(([querySql]) =>
      querySql.includes("UPDATE conversations SET title"),
    );
    expect(updateCall?.[0]).toContain("updated_at");
    expect(updateCall?.[1]).toEqual(["Renamed", FIXED_NOW, "conv-1"]);
  });

  it("deleteConversation() cascades: deletes messages before the conversation", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    await db.deleteConversation("conv-1");

    const deleteCalls = conn.execute.mock.calls.filter(([querySql]) =>
      querySql.startsWith("DELETE"),
    );
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]?.[0]).toContain("DELETE FROM messages WHERE conversation_id");
    expect(deleteCalls[0]?.[1]).toEqual(["conv-1"]);
    expect(deleteCalls[1]?.[0]).toContain("DELETE FROM conversations WHERE id");
    expect(deleteCalls[1]?.[1]).toEqual(["conv-1"]);
  });

  // N2: db.ts deliberately does not wrap writes in BEGIN/COMMIT (see the
  // comment above deleteConversation() — tauri-plugin-sql pools a fresh
  // connection per execute() call, so a JS-level transaction can't be
  // connection-pinned and a stray ROLLBACK could discard a concurrent
  // operation's uncommitted work on the connection it happens to land on).
  // This test would fail both ways a regression could reintroduce that: if
  // BEGIN/COMMIT/ROLLBACK statements come back, or if the ordering that
  // makes an interruption recoverable (children before the parent) is lost.
  it("deleteConversation() sends exactly the two ordered deletes, no transaction statements", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    await db.deleteConversation("conv-1");

    // The first two calls are the lazy CREATE TABLE migrations from getDb();
    // deleteConversation()'s own calls follow.
    const queries = conn.execute.mock.calls.slice(2).map(([q]) => q);
    expect(queries).toEqual([
      expect.stringContaining("DELETE FROM messages"),
      expect.stringContaining("DELETE FROM conversations"),
    ]);
  });

  it("deleteConversation(): if the conversation delete fails, the messages delete has already taken effect and is not rolled back", async () => {
    const conn = makeConn();
    conn.execute.mockImplementation(async (query: string) => {
      if (query.startsWith("DELETE FROM conversations")) {
        throw new Error("disk full");
      }
      return { rowsAffected: 1 };
    });
    const db = await freshDb(conn);

    await expect(db.deleteConversation("conv-1")).rejects.toThrow("disk full");

    // No rollback attempt (there is no real transaction to roll back — see
    // the comment in db.ts): exactly the messages delete, then the failing
    // conversation delete, and nothing else. The messages delete already
    // committed on whatever connection it landed on, which is the whole
    // point of ordering children before the parent — this assertion would
    // fail if a fake ROLLBACK were reintroduced.
    const queries = conn.execute.mock.calls.slice(2).map(([q]) => q);
    expect(queries).toEqual([
      expect.stringContaining("DELETE FROM messages"),
      expect.stringContaining("DELETE FROM conversations"),
    ]);
  });

  it("appendMessage() inserts the message and bumps conversations.updated_at", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    await db.appendMessage({
      conversationId: "conv-1",
      role: "user",
      content: "Hello",
      sourcesJson: null,
    });

    const insertCall = conn.execute.mock.calls.find(([querySql]) =>
      querySql.includes("INSERT INTO messages"),
    );
    expect(insertCall?.[1]).toEqual([FIXED_UUID, "conv-1", "user", "Hello", null, FIXED_NOW]);

    const updateCall = conn.execute.mock.calls.find(([querySql]) =>
      querySql.includes("UPDATE conversations SET updated_at"),
    );
    expect(updateCall?.[1]).toEqual([FIXED_NOW, "conv-1"]);
    // No transaction statements — see the N2 comment on the delete tests
    // above for why. Ordered insert-then-update only.
    const queries = conn.execute.mock.calls.slice(2).map(([q]) => q);
    expect(queries).toEqual([
      expect.stringContaining("INSERT INTO messages"),
      expect.stringContaining("UPDATE conversations SET updated_at"),
    ]);
  });

  it("appendMessage(): if the updated_at bump fails, the message insert has already taken effect and is not rolled back", async () => {
    const conn = makeConn();
    conn.execute.mockImplementation(async (query: string) => {
      if (query.includes("UPDATE conversations SET updated_at")) {
        throw new Error("disk full");
      }
      return { rowsAffected: 1 };
    });
    const db = await freshDb(conn);

    await expect(
      db.appendMessage({
        conversationId: "conv-1",
        role: "user",
        content: "Hello",
        sourcesJson: null,
      }),
    ).rejects.toThrow("disk full");

    // No rollback attempt: the message insert already committed on whatever
    // connection it landed on — losing only the sort-order timestamp bump,
    // never the message itself. This would fail if a fake ROLLBACK were
    // reintroduced.
    const queries = conn.execute.mock.calls.slice(2).map(([q]) => q);
    expect(queries).toEqual([
      expect.stringContaining("INSERT INTO messages"),
      expect.stringContaining("UPDATE conversations SET updated_at"),
    ]);
  });

  it("getMessages() selects a conversation's messages oldest first", async () => {
    const conn = makeConn();
    const db = await freshDb(conn);

    await db.getMessages("conv-1");

    const [querySql, bindValues] = conn.select.mock.calls[0] ?? [];
    expect(querySql).toContain("FROM messages");
    expect(querySql).toContain("WHERE conversation_id = $1");
    expect(querySql).toContain("ORDER BY created_at ASC");
    expect(bindValues).toEqual(["conv-1"]);
  });
});

describe("db (non-Tauri / browser mode)", () => {
  it("never touches the sql plugin: every write/read is a graceful no-op", async () => {
    vi.unstubAllGlobals(); // undo beforeEach's Tauri stub — no __TAURI_INTERNALS__ here
    const conn = makeConn();
    const db = await freshDb(conn);
    const sql = await import("@tauri-apps/plugin-sql");
    // `sql.default.load` is the one mock the hoisted `vi.mock` factory
    // creates for the whole file, so its call count carries over from every
    // earlier Tauri-mode test above (each of which legitimately calls it
    // once) — a delta from this snapshot, not `.not.toHaveBeenCalled()`, is
    // the correct way to prove *this* test never calls it.
    const loadCallsBefore = vi.mocked(sql.default.load).mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await db.initDb();
    expect(await db.listConversations()).toEqual([]);
    const created = await db.createConversation("New chat");
    expect(created).toEqual({
      id: FIXED_UUID,
      title: "New chat",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    await db.renameConversation("conv-1", "Renamed");
    await db.deleteConversation("conv-1");
    await db.appendMessage({
      conversationId: "conv-1",
      role: "user",
      content: "Hello",
      sourcesJson: null,
    });
    expect(await db.getMessages("conv-1")).toEqual([]);

    // The plugin is never loaded, so it can never throw the raw
    // "Cannot read properties of undefined (reading 'invoke')" error.
    expect(vi.mocked(sql.default.load).mock.calls.length).toBe(loadCallsBefore);
    expect(conn.execute).not.toHaveBeenCalled();
    expect(conn.select).not.toHaveBeenCalled();
    // One console.warn regardless of how many browser-mode calls were made.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "lib/db: no Tauri runtime detected — conversations will not persist.",
    );
  });
});
