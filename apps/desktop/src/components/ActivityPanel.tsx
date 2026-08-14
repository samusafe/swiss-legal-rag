import { Button, Chip, Select, SelectItem, Spinner } from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import {
  AUDIT_GROUPS,
  AUDIT_PAGE_SIZE,
  allAuditEvents,
  auditSummary,
  queryAudit,
} from "../lib/audit";
import type { AuditGroup, AuditRow, AuditType } from "../lib/audit";
import { t } from "../i18n";
import { firstSelectionKey } from "./SettingsModal";

type Range = 7 | 30 | 90;
const RANGES: readonly Range[] = [7, 30, 90];
const GROUPS = Object.keys(AUDIT_GROUPS) as AuditGroup[];

// Explicit lookups (not template-literal keys) so the dict key union
// typechecks under strict mode — same pattern as Header's THEME_LABEL_KEYS.
const GROUP_LABEL_KEYS = {
  chat: "activity.group.chat",
  search: "activity.group.search",
  reading: "activity.group.reading",
  management: "activity.group.management",
  errors: "activity.group.errors",
} as const;
const RANGE_LABEL_KEYS = {
  7: "activity.range7",
  30: "activity.range30",
  90: "activity.range90",
} as const;

// Reverse of AUDIT_GROUPS: every AuditType maps to its group, used to pick
// the row Chip's color.
const GROUP_OF = Object.fromEntries(
  (Object.entries(AUDIT_GROUPS) as Array<[AuditGroup, readonly AuditType[]]>).flatMap(
    ([group, types]) => types.map((type) => [type, group] as const),
  ),
) as Record<AuditType, AuditGroup>;

const GROUP_CHIP_COLOR = {
  chat: "primary",
  search: "secondary",
  reading: "success",
  management: "default",
  errors: "danger",
} as const satisfies Record<AuditGroup, "primary" | "secondary" | "success" | "default" | "danger">;

const OUTCOME_LABEL_KEYS = {
  done: "activity.outcome.done",
  stopped: "activity.outcome.stopped",
  failed: "activity.outcome.failed",
} as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}
function str(rec: JsonRecord, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}
function strOrNull(rec: JsonRecord, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}
function num(rec: JsonRecord, key: string): number {
  const v = rec[key];
  return typeof v === "number" ? v : 0;
}
function bool(rec: JsonRecord, key: string): boolean {
  return rec[key] === true;
}
function isOutcome(value: string): value is keyof typeof OUTCOME_LABEL_KEYS {
  return value in OUTCOME_LABEL_KEYS;
}
/** First 8 chars of a UUID — enough to distinguish rows without the full id. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Human-readable one-line rendering per event type, built from the parsed
 * `detail` payload (see lib/audit.ts's logAudit call sites for each type's
 * shape). Falls back to the raw string when `detail` isn't valid JSON. */
export function describeEvent(row: AuditRow): string {
  let detail: JsonRecord;
  try {
    detail = asRecord(JSON.parse(row.detail));
  } catch {
    return row.detail;
  }

  switch (row.type) {
    case "chat.question":
      return row.question ?? shortId(str(detail, "conversationId"));
    case "chat.answer": {
      const outcome = str(detail, "outcome");
      const outcomeLabel = isOutcome(outcome) ? t(OUTCOME_LABEL_KEYS[outcome]) : outcome;
      const parts = [outcomeLabel, t("activity.citations", { n: num(detail, "citations") })];
      const model = strOrNull(detail, "model");
      if (model !== null) parts.push(model);
      if (bool(detail, "refusal")) parts.push(t("activity.refusal"));
      return parts.join(" · ");
    }
    case "search.query":
      return `«${str(detail, "query")}» · ${t("activity.results", { n: num(detail, "results") })}`;
    case "article.open":
      return `${str(detail, "collection")} ${str(detail, "number")} Art. ${str(detail, "article")} · ${str(detail, "lang").toUpperCase()} · ${str(detail, "origin")}`;
    case "article.langSwitch":
      return `${str(detail, "collection")} ${str(detail, "number")} Art. ${str(detail, "article")} · ${str(detail, "from").toUpperCase()} → ${str(detail, "to").toUpperCase()}`;
    case "article.external":
      return `${str(detail, "collection")} ${str(detail, "number")} Art. ${str(detail, "article")}`;
    case "settings.jurisdiction": {
      const from = asRecord(detail["from"]);
      const to = asRecord(detail["to"]);
      return `${strOrNull(from, "canton") ?? "—"} → ${strOrNull(to, "canton") ?? "—"}`;
    }
    case "convo.create":
    case "convo.rename":
    case "convo.delete":
      return shortId(str(detail, "conversationId"));
    case "convo.export":
      return `${shortId(str(detail, "conversationId"))} · ${str(detail, "format")}`;
    case "ingest.start":
      return "";
    case "ingest.finish":
      return t("activity.chunks", { n: num(detail, "chunks") });
    case "ingest.error":
    case "error.ui":
      return str(detail, "message");
    case "error.api": {
      const requestId = strOrNull(detail, "requestId");
      const base = `${str(detail, "endpoint")} · ${num(detail, "status")} · ${str(detail, "message")}`;
      return requestId !== null ? `${base} · ${shortId(requestId)}` : base;
    }
    default:
      return row.detail;
  }
}

/** Pretty-printed detail JSON for the expanded row view; falls back to the
 * raw string when `detail` isn't valid JSON. */
function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

export function ActivityPanel() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof auditSummary>> | null>(null);
  const [group, setGroup] = useState<AuditGroup | null>(null);
  const [range, setRange] = useState<Range>(30);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    auditSummary()
      .then(setSummary)
      .catch((cause: unknown) => {
        console.error("activity: summary failed", cause);
        setError(true);
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(false);
    queryAudit(group, range, page)
      .then((result) => {
        setRows(result.rows);
        setTotal(result.total);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        console.error("activity: query failed", cause);
        setLoading(false);
        setError(true);
      });
  }, [group, range, page]);

  const handleExport = useCallback(async () => {
    setExported(false);
    setExportError(null);
    try {
      const path = await save({
        defaultPath: "activity.jsonl",
        filters: [{ name: "JSONL", extensions: ["jsonl"] }],
      });
      if (path === null) return;
      const events = await allAuditEvents();
      const contents = events
        .map(({ id, ts, type, detail, durationMs }) =>
          JSON.stringify({ id, ts, type, detail: JSON.parse(detail), durationMs }),
        )
        .join("\n");
      await invoke("write_export", { path, contents });
      setExported(true);
    } catch (cause) {
      console.error("activity: export failed", cause);
      setExportError(t("activity.exportError"));
    }
  }, []);

  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4 py-2">
      {/* SettingsModal is size="lg" (max-w-lg, ~464px of content width after
          px-6 padding) — that width is fixed regardless of the app window's
          own size, since Tailwind's sm:/md: breakpoints key off the
          *viewport*, not this modal. 5 columns at ~464px leaves each card
          under 90px and cramps the two count lines; 3 columns (~150px each)
          is the most that reads well, so the grid never goes past
          sm:grid-cols-3 even on a wide window. */}
      <div data-testid="activity-summary-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g} className="rounded-sm border border-divider p-2 text-center">
            <p className="text-xs text-foreground-400">{t(GROUP_LABEL_KEYS[g])}</p>
            <p className="text-sm tabular-nums">
              {`${t("activity.last7")}: ${summary?.[g].last7 ?? 0}`}
            </p>
            <p className="text-sm tabular-nums">
              {`${t("activity.last30")}: ${summary?.[g].last30 ?? 0}`}
            </p>
          </div>
        ))}
      </div>
      {/* flex-wrap: the two Selects plus the export Button don't fit on one
          line at the modal's ~464px content width (size="lg") — wrap instead
          of overflowing horizontally. */}
      <div className="flex flex-wrap gap-2">
        <Select
          label={t("activity.all")}
          className="max-w-40"
          selectedKeys={group === null ? new Set(["all"]) : new Set([group])}
          onSelectionChange={(keys) => {
            const key = firstSelectionKey(keys);
            setPage(1);
            setGroup(key !== null && key !== "all" ? (key as AuditGroup) : null);
          }}
        >
          {["all", ...GROUPS].map((key) => (
            <SelectItem key={key}>
              {key === "all" ? t("activity.all") : t(GROUP_LABEL_KEYS[key as AuditGroup])}
            </SelectItem>
          ))}
        </Select>
        <Select
          label={t("activity.range30")}
          className="max-w-32"
          selectedKeys={new Set([String(range)])}
          onSelectionChange={(keys) => {
            const key = firstSelectionKey(keys);
            if (key !== null) {
              setPage(1);
              setRange(Number(key) as Range);
            }
          }}
        >
          {RANGES.map((r) => (
            <SelectItem key={String(r)}>{t(RANGE_LABEL_KEYS[r])}</SelectItem>
          ))}
        </Select>
        <Button className="ml-auto self-center" size="sm" onPress={() => void handleExport()}>
          {t("activity.export")}
        </Button>
      </div>
      {exported && <p className="text-sm text-success">{t("activity.exported")}</p>}
      {exportError !== null && (
        <p role="alert" className="text-sm text-danger">
          {exportError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {t("activity.error")}
        </p>
      )}
      {loading && !error && <Spinner size="sm" />}
      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-foreground-400">{t("activity.empty")}</p>
      )}
      {/* Single scroll container: SettingsModal's Modal has
          scrollBehavior="inside", so its ModalBody is the one region that
          scrolls for this whole tab (summary cards, filters, this list, and
          pagination). The list used to carry its own max-h-72
          overflow-y-auto, which nested a second scroll region inside the
          modal body — at the 800x600 window floor that meant scrolling the
          list to its end and *then* separately scrolling the body to reach
          pagination. Rows just flow in-line here instead. */}
      {!loading && !error && rows.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 text-sm">
              <button
                type="button"
                className="flex w-full items-baseline gap-2 text-left"
                aria-expanded={expandedIds.has(row.id)}
                aria-label={t("activity.expand")}
                onClick={() => toggleExpanded(row.id)}
              >
                <span className="shrink-0 tabular-nums text-foreground-400">
                  {row.ts.slice(0, 16).replace("T", " ")}
                </span>
                <Chip size="sm" variant="flat" color={GROUP_CHIP_COLOR[GROUP_OF[row.type]]}>
                  {row.type}
                </Chip>
                <span className="truncate text-foreground-500">{describeEvent(row)}</span>
                {row.durationMs !== null && (
                  <span className="ml-auto shrink-0 tabular-nums text-foreground-400">
                    {row.durationMs} ms
                  </span>
                )}
              </button>
              {expandedIds.has(row.id) && (
                // Bounded height + its own scroll: a large detail payload
                // (e.g. a full ingest.finish record) must not push the rest
                // of the modal off-screen the way the unbounded <pre> used to.
                <pre className="max-h-48 overflow-auto rounded-sm bg-content2 p-2 font-mono text-xs">
                  {prettyDetail(row.detail)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {!loading && !error && pages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("activity.prev")}
            isDisabled={page <= 1}
            onPress={() => setPage((p) => p - 1)}
          >
            ‹
          </Button>
          <span className="text-xs tabular-nums text-foreground-400">
            {page} / {pages}
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("activity.next")}
            isDisabled={page >= pages}
            onPress={() => setPage((p) => p + 1)}
          >
            ›
          </Button>
        </div>
      )}
    </div>
  );
}
