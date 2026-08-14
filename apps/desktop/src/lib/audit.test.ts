import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@tauri-apps/plugin-sql";
import type Database from "@tauri-apps/plugin-sql";
import { AUDIT_GROUPS } from "./audit";

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

/** Fresh copy of audit.ts (its module-level connection cache included) per test. */
async function freshAudit(conn: FakeConn) {
  vi.resetModules();
  const sql = await import("@tauri-apps/plugin-sql");
  vi.mocked(sql.default.load).mockResolvedValue(conn as unknown as Database);
  return import("./audit");
}

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AUDIT_GROUPS", () => {
  it("groups jurisdiction-aware reading/management events, not the removed article.fedlex", () => {
    expect(AUDIT_GROUPS.reading).toEqual(["article.open", "article.langSwitch", "article.external"]);
    expect(AUDIT_GROUPS.management).toContain("settings.jurisdiction");
    for (const types of Object.values(AUDIT_GROUPS)) {
      expect(types).not.toContain("article.fedlex");
    }
  });
});

describe("logAudit", () => {
  it("inserts an event with ISO timestamp, type, JSON detail, and duration", async () => {
    const conn = makeConn();
    const { logAudit } = await freshAudit(conn);

    logAudit("search.query", { query: "kündigung", lang: "de", results: 8 }, 1200);

    await vi.waitFor(() =>
      expect(conn.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_events"),
        [
          expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          "search.query",
          JSON.stringify({ query: "kündigung", lang: "de", results: 8 }),
          1200,
        ],
      ),
    );
  });

  it("accepts the article.external and settings.jurisdiction audit types", async () => {
    const conn = makeConn();
    const { logAudit } = await freshAudit(conn);

    logAudit("article.external", { collection: "SR", number: "220", article: "335c" });
    logAudit("settings.jurisdiction", {
      from: { jurisdiction: "federal" },
      to: { jurisdiction: "cantonal", canton: "ZH" },
    });

    await vi.waitFor(() =>
      expect(conn.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO audit_events"),
        expect.arrayContaining(["article.external"]),
      ),
    );
    expect(conn.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_events"),
      expect.arrayContaining(["settings.jurisdiction"]),
    );
  });

  it("swallows and logs a write failure without throwing", async () => {
    const conn = makeConn();
    conn.execute.mockImplementation(async (query: string) => {
      if (query.includes("INSERT INTO audit_events")) {
        throw new Error("disk full");
      }
      return { rowsAffected: 1 };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { logAudit } = await freshAudit(conn);

    expect(() => logAudit("error.ui", { message: "boom" })).not.toThrow();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("audit"),
        expect.anything(),
      ),
    );
  });
});

describe("initAudit", () => {
  it("prunes events older than 90 days", async () => {
    const conn = makeConn();
    const { initAudit } = await freshAudit(conn);
    const before = Date.now();

    initAudit();

    await vi.waitFor(() =>
      expect(conn.execute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM audit_events WHERE ts < $1"),
        [expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)],
      ),
    );

    const call = conn.execute.mock.calls.find(([query]) =>
      query.includes("DELETE FROM audit_events"),
    );
    const cutoff = new Date(String(call?.[1]?.[0])).getTime();
    const expectedCutoff = before - 90 * 24 * 60 * 60 * 1000;
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(oneDayMs);
  });
});

describe("queryAudit", () => {
  it("filters by group types, pages by 50, and returns total", async () => {
    const conn = makeConn();
    conn.select.mockImplementation(async (query: string) => {
      if (query.includes("COUNT(*)")) return [{ total: 120 }];
      return [];
    });
    const { queryAudit } = await freshAudit(conn);

    const result = await queryAudit("reading", 30, 2);

    expect(result.total).toBe(120);
    expect(result.rows).toEqual([]);

    const dataCall = conn.select.mock.calls.find(
      ([query]) => !query.includes("COUNT(*)"),
    );
    const [dataSql, dataParams] = dataCall ?? [];
    expect(dataSql).toContain("LIMIT 50 OFFSET 50");
    // 4th param slot is the legacy "article.fedlex" type folded into "reading"
    // (see M1 test below) — old rows must still surface under this filter.
    expect(dataSql).toMatch(/IN \(\$2, \$3, \$4, \$5\)/);
    expect(dataParams).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "article.open",
      "article.langSwitch",
      "article.external",
      "article.fedlex",
    ]);
  });

  // M1: legacy "article.fedlex" rows (written before the type was retired in
  // favor of "article.external") must still surface under the "reading" group
  // filter, without AUDIT_GROUPS.reading itself listing the retired type.
  it("includes legacy article.fedlex rows in the reading group filter", async () => {
    const conn = makeConn();
    conn.select.mockImplementation(async (query: string) => {
      if (query.includes("COUNT(*)")) return [{ total: 1 }];
      return [
        {
          id: 1,
          ts: "2026-08-10T09:00:00.000Z",
          type: "article.fedlex",
          detail: '{"sr":"220","article":"335c"}',
          durationMs: null,
          question: null,
        },
      ];
    });
    const { queryAudit } = await freshAudit(conn);

    const result = await queryAudit("reading", 30, 1);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.type).toBe("article.fedlex");
    const dataCall = conn.select.mock.calls.find(
      ([query]) => !query.includes("COUNT(*)"),
    );
    const [, dataParams] = dataCall ?? [];
    expect(dataParams).toContain("article.fedlex");
  });

  // I5: the messages JOIN — the riskiest SQL in the feature — was executed
  // by no test at any level. Asserts both the SQL shape and that a joined
  // row's `question`/`durationMs` alias through correctly.
  it("LEFT JOINs messages via json_extract on the chat.question detail's messageId", async () => {
    const conn = makeConn();
    conn.select.mockImplementation(async (query: string) => {
      if (query.includes("COUNT(*)")) return [{ total: 1 }];
      return [
        {
          id: 7,
          ts: "2026-08-10T09:00:00.000Z",
          type: "chat.question",
          detail: '{"conversationId":"c1","messageId":"m1"}',
          durationMs: null,
          question: "Wie lang ist die Kündigungsfrist?",
        },
      ];
    });
    const { queryAudit } = await freshAudit(conn);

    const result = await queryAudit(null, 30, 1);

    expect(result.rows[0]).toMatchObject({
      question: "Wie lang ist die Kündigungsfrist?",
      durationMs: null,
    });
    const dataCall = conn.select.mock.calls.find(
      ([query]) => !query.includes("COUNT(*)"),
    );
    const [dataSql] = dataCall ?? [];
    expect(dataSql).toContain("LEFT JOIN messages m");
    expect(dataSql).toContain(
      "ON a.type = 'chat.question' AND m.id = json_extract(a.detail, '$.messageId')",
    );
  });
});

describe("auditSummary", () => {
  it("aggregates per-type counts into their group's last7/last30 buckets", async () => {
    const conn = makeConn();
    let call = 0;
    conn.select.mockImplementation(async () => {
      call += 1;
      // First call is the last-7-days window, second is last-30-days —
      // exercises both the two-pass accumulation and the groupOf mapping
      // (chat.question + chat.answer both fold into the "chat" group).
      if (call === 1) {
        return [
          { type: "chat.question", n: 2 },
          { type: "chat.answer", n: 1 },
          { type: "search.query", n: 4 },
        ];
      }
      return [
        { type: "chat.question", n: 5 },
        { type: "article.open", n: 3 },
      ];
    });
    const { auditSummary } = await freshAudit(conn);

    const summary = await auditSummary();

    expect(summary).toEqual({
      chat: { last7: 3, last30: 5 },
      search: { last7: 4, last30: 0 },
      reading: { last7: 0, last30: 3 },
      management: { last7: 0, last30: 0 },
      errors: { last7: 0, last30: 0 },
    });
    expect(conn.select).toHaveBeenCalledTimes(2);
  });

  // M1: a legacy "article.fedlex" row must still land in the "reading" bucket
  // instead of being silently dropped from the count.
  it("folds legacy article.fedlex rows into the reading bucket", async () => {
    const conn = makeConn();
    let call = 0;
    conn.select.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return [{ type: "article.fedlex", n: 2 }];
      }
      return [
        { type: "article.fedlex", n: 3 },
        { type: "article.external", n: 1 },
      ];
    });
    const { auditSummary } = await freshAudit(conn);

    const summary = await auditSummary();

    expect(summary.reading).toEqual({ last7: 2, last30: 4 });
  });
});

describe("allAuditEvents", () => {
  it("selects every row ordered ascending by ts, unfiltered", async () => {
    const conn = makeConn();
    const fakeRows = [
      {
        id: 1,
        ts: "2026-08-01T00:00:00.000Z",
        type: "search.query",
        detail: "{}",
        durationMs: null,
        question: null,
      },
      {
        id: 2,
        ts: "2026-08-02T00:00:00.000Z",
        type: "chat.question",
        detail: "{}",
        durationMs: null,
        question: null,
      },
    ];
    conn.select.mockResolvedValue(fakeRows);
    const { allAuditEvents } = await freshAudit(conn);

    const rows = await allAuditEvents();

    expect(rows).toEqual(fakeRows);
    const [sql] = conn.select.mock.calls[0] ?? [];
    expect(sql).toContain("ORDER BY ts ASC");
    expect(sql).not.toContain("WHERE");
  });
});
