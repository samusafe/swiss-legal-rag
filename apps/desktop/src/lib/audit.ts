import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "./db";

export type AuditType =
  | "chat.question"
  | "chat.answer"
  | "search.query"
  | "article.open"
  | "article.langSwitch"
  | "article.fedlex"
  | "convo.create"
  | "convo.rename"
  | "convo.delete"
  | "convo.export"
  | "ingest.start"
  | "ingest.finish"
  | "ingest.error"
  | "error.ui"
  | "error.api";

export const AUDIT_GROUPS = {
  chat: ["chat.question", "chat.answer"],
  search: ["search.query"],
  reading: ["article.open", "article.langSwitch", "article.fedlex"],
  management: [
    "convo.create",
    "convo.rename",
    "convo.delete",
    "convo.export",
    "ingest.start",
    "ingest.finish",
    "ingest.error",
  ],
  errors: ["error.ui", "error.api"],
} as const satisfies Record<string, readonly AuditType[]>;

export type AuditGroup = keyof typeof AUDIT_GROUPS;

export const AUDIT_PAGE_SIZE = 50;

export interface AuditRow {
  id: number;
  ts: string;
  type: AuditType;
  detail: string; // JSON, shape per type (see spec table)
  durationMs: number | null;
  question: string | null; // joined messages.content for chat.question rows
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    detail      TEXT    NOT NULL DEFAULT '{}',
    duration_ms INTEGER
  )
`;
const CREATE_IDX_TS = "CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (ts)";
const CREATE_IDX_TYPE = "CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events (type, ts)";

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same lazy single-connection memoization as lib/db.ts — and the same
// connection string, so tauri-plugin-sql hands back the same pool (one DB
// file for conversations and audit, enabling the viewer's JOIN).
let db: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (db === null) {
    db = (async () => {
      const conn = await Database.load("sqlite:conversations.db");
      await conn.execute(CREATE_SQL);
      await conn.execute(CREATE_IDX_TS);
      await conn.execute(CREATE_IDX_TYPE);
      return conn;
    })();
  }
  return db;
}

/** Fire-and-forget: auditing must never affect the feature it observes —
 * failures are logged with context and swallowed (deliberate exception to
 * the project's fail-loud rule; see spec). */
export function logAudit(
  type: AuditType,
  detail: Record<string, unknown>,
  durationMs?: number,
): void {
  if (!isTauri()) return;
  void (async () => {
    const conn = await getDb();
    await conn.execute(
      "INSERT INTO audit_events (ts, type, detail, duration_ms) VALUES ($1, $2, $3, $4)",
      [new Date().toISOString(), type, JSON.stringify(detail), durationMs ?? null],
    );
  })().catch((error: unknown) => console.error(`audit: failed to log ${type}`, error));
}

/** Ensure the table exists and apply the 90-day retention. Fire-and-forget
 * on app start — a failed prune never blocks startup. */
export function initAudit(): void {
  if (!isTauri()) return;
  void (async () => {
    const conn = await getDb();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString();
    await conn.execute("DELETE FROM audit_events WHERE ts < $1", [cutoff]);
  })().catch((error: unknown) => console.error("audit: retention prune failed", error));
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

export async function queryAudit(
  group: AuditGroup | null,
  sinceDays: 7 | 30 | 90,
  page: number,
): Promise<{ rows: AuditRow[]; total: number }> {
  if (!isTauri()) return { rows: [], total: 0 };
  const conn = await getDb();
  const params: unknown[] = [sinceIso(sinceDays)];
  let typeFilter = "";
  if (group !== null) {
    const types = AUDIT_GROUPS[group];
    typeFilter = ` AND a.type IN (${types.map((_, i) => `$${i + 2}`).join(", ")})`;
    params.push(...types);
  }
  const where = `WHERE a.ts >= $1${typeFilter}`;
  const countRows = await conn.select<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM audit_events a ${where}`,
    params,
  );
  const offset = (page - 1) * AUDIT_PAGE_SIZE;
  const rows = await conn.select<AuditRow[]>(
    `SELECT a.id, a.ts, a.type, a.detail, a.duration_ms AS durationMs,
            m.content AS question
     FROM audit_events a
     LEFT JOIN messages m
       ON a.type = 'chat.question' AND m.id = json_extract(a.detail, '$.messageId')
     ${where}
     ORDER BY a.ts DESC
     LIMIT ${AUDIT_PAGE_SIZE} OFFSET ${offset}`,
    params,
  );
  return { rows, total: countRows[0]?.total ?? 0 };
}

export async function auditSummary(): Promise<
  Record<AuditGroup, { last7: number; last30: number }>
> {
  const summary = Object.fromEntries(
    (Object.keys(AUDIT_GROUPS) as AuditGroup[]).map((g) => [g, { last7: 0, last30: 0 }]),
  ) as Record<AuditGroup, { last7: number; last30: number }>;
  if (!isTauri()) return summary;
  const conn = await getDb();
  const groupOf = new Map<string, AuditGroup>();
  for (const [group, types] of Object.entries(AUDIT_GROUPS)) {
    for (const type of types) groupOf.set(type, group as AuditGroup);
  }
  for (const [days, key] of [
    [7, "last7"],
    [30, "last30"],
  ] as const) {
    const counts = await conn.select<Array<{ type: string; n: number }>>(
      "SELECT type, COUNT(*) AS n FROM audit_events WHERE ts >= $1 GROUP BY type",
      [sinceIso(days)],
    );
    for (const { type, n } of counts) {
      const group = groupOf.get(type);
      if (group !== undefined) summary[group][key] += n;
    }
  }
  return summary;
}

export async function allAuditEvents(): Promise<AuditRow[]> {
  if (!isTauri()) return [];
  const conn = await getDb();
  return conn.select<AuditRow[]>(
    `SELECT id, ts, type, detail, duration_ms AS durationMs, NULL AS question
     FROM audit_events ORDER BY ts ASC`,
  );
}
