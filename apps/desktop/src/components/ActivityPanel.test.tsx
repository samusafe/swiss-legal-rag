import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../i18n";
import { ActivityPanel, describeEvent } from "./ActivityPanel";
import type { AuditRow } from "../lib/audit";

vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return {
    ...actual,
    queryAudit: vi.fn(),
    auditSummary: vi.fn(),
    allAuditEvents: vi.fn(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { allAuditEvents, auditSummary, queryAudit } from "../lib/audit";

const queryAuditMock = vi.mocked(queryAudit);
const auditSummaryMock = vi.mocked(auditSummary);
const allAuditEventsMock = vi.mocked(allAuditEvents);
const saveMock = vi.mocked(save);
const invokeMock = vi.mocked(invoke);

const SUMMARY = {
  chat: { last7: 3, last30: 12 },
  search: { last7: 1, last30: 4 },
  reading: { last7: 2, last30: 9 },
  management: { last7: 0, last30: 1 },
  errors: { last7: 0, last30: 0 },
};

const ROWS = [
  {
    id: 2,
    ts: "2026-08-10T09:00:00.000Z",
    type: "chat.question" as const,
    detail: "{}",
    durationMs: null,
    question: "Wie lang ist die Kündigungsfrist?",
  },
  {
    id: 1,
    ts: "2026-08-09T08:00:00.000Z",
    type: "article.open" as const,
    detail: '{"sr":"220","article":"335c"}',
    durationMs: null,
    question: null,
  },
];

function renderPanel() {
  render(
    <HeroUIProvider>
      <ActivityPanel />
    </HeroUIProvider>,
  );
}

describe("ActivityPanel", () => {
  beforeEach(() => {
    setLang("en");
    queryAuditMock.mockReset();
    auditSummaryMock.mockReset();
    allAuditEventsMock.mockReset();
    saveMock.mockReset();
    invokeMock.mockReset();
    auditSummaryMock.mockResolvedValue(SUMMARY);
    queryAuditMock.mockResolvedValue({ rows: ROWS, total: ROWS.length });
  });

  it("renders group summaries and the event list", async () => {
    renderPanel();

    expect(await screen.findByText("Wie lang ist die Kündigungsfrist?")).toBeInTheDocument();
    expect(screen.getByText("article.open")).toBeInTheDocument();
    // Chat group summary: 3 events in the last 7 days.
    expect(screen.getByText("Last 7 days: 3")).toBeInTheDocument();
  });

  it("filters by group when a group is selected", async () => {
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");
    queryAuditMock.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "All All" }));
    await user.click(await screen.findByRole("option", { name: "Errors" }));

    await vi.waitFor(() =>
      expect(queryAuditMock).toHaveBeenCalledWith("errors", 30, 1),
    );
  });

  it("exports JSONL through the save dialog and write_export", async () => {
    saveMock.mockResolvedValue("C:\\tmp\\activity.jsonl");
    allAuditEventsMock.mockResolvedValue(ROWS);
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export JSONL" }));

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const [command, args] = invokeMock.mock.calls[0] as [string, { path: string; contents: string }];
    expect(command).toBe("write_export");
    expect(args.path).toBe("C:\\tmp\\activity.jsonl");
    const lines = args.contents.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("shows the error string when queryAudit rejects", async () => {
    queryAuditMock.mockReset();
    queryAuditMock.mockRejectedValue(new Error("boom"));
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load activity.");
  });

  // I4 regression: handleExport used to be invoked as `void handleExport()`
  // with no try/catch, so every failure mode (save/write_export rejecting)
  // became an unhandled rejection with nothing shown to the user.
  it("shows an inline error when the export write fails, instead of failing silently", async () => {
    saveMock.mockResolvedValue("C:\\tmp\\activity.jsonl");
    allAuditEventsMock.mockResolvedValue(ROWS);
    invokeMock.mockRejectedValue(new Error("permission denied"));
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export JSONL" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Export failed.");
    expect(screen.queryByText("Activity log exported.")).not.toBeInTheDocument();
  });

  // I5: pagination was untested — queryAudit/auditSummary/allAuditEvents
  // are all mocked in this file, so nothing exercised the next-page wiring.
  it("shows pagination controls and re-queries page 2 when total exceeds one page", async () => {
    queryAuditMock.mockResolvedValue({ rows: ROWS, total: 120 });
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");
    queryAuditMock.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next page" }));

    await vi.waitFor(() => expect(queryAuditMock).toHaveBeenCalledWith(null, 30, 2));
  });

  // I6: rows used to render the raw detail JSON, truncated by CSS
  // (`{"conversationId":"f393d53d-…`); expand each row to read the full
  // payload in-app instead of only via export.
  it("reveals the pretty JSON detail when a row's expand control is clicked", async () => {
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const user = userEvent.setup();
    const toggles = screen.getAllByRole("button", { name: "Show details" });
    // ROWS[1] is the article.open row with a non-trivial detail payload.
    await user.click(toggles[1]);

    expect(await screen.findByText(/"sr":\s*"220"/)).toBeInTheDocument();
  });

  // Responsiveness fix: an expanded detail payload used to render in an
  // unbounded <pre>, which could grow tall enough to push the rest of the
  // (now scrollBehavior="inside") SettingsModal off-screen at the 800x600
  // window floor.
  it("bounds the expanded detail <pre> to a fixed height with its own scroll", async () => {
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const user = userEvent.setup();
    const toggles = screen.getAllByRole("button", { name: "Show details" });
    await user.click(toggles[1]);

    const pre = await screen.findByText(/"sr":\s*"220"/);
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toContain("max-h-48");
    expect(pre.className).toContain("overflow-auto");
  });

  it("wraps the group/range filters and export button instead of overflowing horizontally", async () => {
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const filtersRow = screen.getByRole("button", { name: "Export JSONL" }).closest("div");
    expect(filtersRow?.className).toContain("flex-wrap");
  });

  it("keeps the summary grid to at most 3 columns so cards don't cramp at the modal's width", async () => {
    renderPanel();
    await screen.findByText("Wie lang ist die Kündigungsfrist?");

    const grid = screen.getByTestId("activity-summary-grid");
    expect(grid.className).toContain("sm:grid-cols-3");
    expect(grid.className).not.toContain("grid-cols-5");
  });

  it("renders article.external and settings.jurisdiction rows in the event list", async () => {
    queryAuditMock.mockResolvedValue({
      rows: [
        {
          id: 3,
          ts: "2026-08-11T10:00:00.000Z",
          type: "article.external",
          detail: JSON.stringify({ collection: "ZH", number: "131.1", article: "5" }),
          durationMs: null,
          question: null,
        },
        {
          id: 4,
          ts: "2026-08-11T11:00:00.000Z",
          type: "settings.jurisdiction",
          detail: JSON.stringify({
            from: { jurisdiction: "federal" },
            to: { jurisdiction: "cantonal", canton: "ZH" },
          }),
          durationMs: null,
          question: null,
        },
      ],
      total: 2,
    });
    renderPanel();

    expect(await screen.findByText("ZH 131.1 Art. 5")).toBeInTheDocument();
    expect(screen.getByText("— → ZH")).toBeInTheDocument();
    expect(screen.getByText("article.external")).toBeInTheDocument();
    expect(screen.getByText("settings.jurisdiction")).toBeInTheDocument();
  });
});

describe("describeEvent", () => {
  beforeEach(() => {
    setLang("en");
  });

  function row(overrides: Partial<AuditRow>): AuditRow {
    return {
      id: 1,
      ts: "2026-08-10T09:00:00.000Z",
      type: "chat.question",
      detail: "{}",
      durationMs: null,
      question: null,
      ...overrides,
    };
  }

  it("renders a chat.answer summary with outcome, citation count, model, and refusal", () => {
    const result = describeEvent(
      row({
        type: "chat.answer",
        detail: JSON.stringify({
          conversationId: "abc",
          messageId: "def",
          model: "llama3",
          outcome: "done",
          refusal: true,
          citations: 0,
        }),
      }),
    );
    expect(result).toBe(
      `${t("activity.outcome.done")} · ${t("activity.citations", { n: 0 })} · llama3 · ${t("activity.refusal")}`,
    );
  });

  it("renders a search.query summary with the quoted query and result count", () => {
    const result = describeEvent(
      row({
        type: "search.query",
        detail: JSON.stringify({ query: "Kündigung", lang: "de", results: 7 }),
      }),
    );
    expect(result).toBe(`«Kündigung» · ${t("activity.results", { n: 7 })}`);
  });

  it("renders an error.api summary with endpoint, status, message, and truncated requestId", () => {
    const result = describeEvent(
      row({
        type: "error.api",
        detail: JSON.stringify({
          endpoint: "/chat",
          status: 500,
          message: "boom",
          requestId: "abcdef1234567890",
        }),
      }),
    );
    expect(result).toBe("/chat · 500 · boom · abcdef12");
  });

  it("falls back to the raw string when detail is not valid JSON", () => {
    const result = describeEvent(row({ type: "ingest.error", detail: "not json" }));
    expect(result).toBe("not json");
  });

  it("renders an article.open summary from the generalized collection/number detail", () => {
    const result = describeEvent(
      row({
        type: "article.open",
        detail: JSON.stringify({
          collection: "SR",
          number: "220",
          article: "335c",
          lang: "de",
          origin: "card",
        }),
      }),
    );
    expect(result).toBe("SR 220 Art. 335c · DE · card");
  });

  it("renders an article.langSwitch summary from the generalized collection/number detail", () => {
    const result = describeEvent(
      row({
        type: "article.langSwitch",
        detail: JSON.stringify({
          collection: "SR",
          number: "220",
          article: "335c",
          from: "de",
          to: "fr",
        }),
      }),
    );
    expect(result).toBe("SR 220 Art. 335c · DE → FR");
  });

  it("renders an article.external summary with collection, number, and article", () => {
    const result = describeEvent(
      row({
        type: "article.external",
        detail: JSON.stringify({ collection: "ZH", number: "131.1", article: "5" }),
      }),
    );
    expect(result).toBe("ZH 131.1 Art. 5");
  });

  it("renders a settings.jurisdiction summary as from-canton arrow to-canton", () => {
    const result = describeEvent(
      row({
        type: "settings.jurisdiction",
        detail: JSON.stringify({
          from: { jurisdiction: "cantonal", canton: "ZH" },
          to: { jurisdiction: "cantonal", canton: "BE" },
        }),
      }),
    );
    expect(result).toBe("ZH → BE");
  });

  it("renders a settings.jurisdiction summary with an em dash when a side has no canton (federal)", () => {
    const result = describeEvent(
      row({
        type: "settings.jurisdiction",
        detail: JSON.stringify({
          from: { jurisdiction: "federal" },
          to: { jurisdiction: "cantonal", canton: "GE" },
        }),
      }),
    );
    expect(result).toBe("— → GE");
  });

  // Historical SQLite rows keep the pre-migration type string and detail
  // shape (removed from AuditType, so the DB's runtime value is asserted
  // past the type system here) — the row must fall back to raw rendering
  // instead of throwing.
  it("falls back without crashing for a historical article.fedlex row with an old {sr} detail", () => {
    const legacyRow = row({
      type: "article.fedlex" as unknown as AuditRow["type"],
      detail: JSON.stringify({ sr: "220", article: "335c" }),
    });
    expect(() => describeEvent(legacyRow)).not.toThrow();
    expect(describeEvent(legacyRow)).toBe(JSON.stringify({ sr: "220", article: "335c" }));
  });
});
