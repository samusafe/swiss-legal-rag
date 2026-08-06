import { Chip } from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Source } from "../lib/api";

export function SourcesPanel({ sources }: { sources: Source[] }) {
  return (
    <aside className="flex flex-col gap-2 overflow-y-auto border-l border-divider p-4">
      <h2 className="text-sm font-semibold uppercase text-foreground-500">
        Retrieved articles
      </h2>
      {sources.length === 0 && (
        <p className="text-sm text-foreground-400">
          Ask a question to see the articles behind the answer.
        </p>
      )}
      {sources.map((source, i) => (
        <div
          key={`${source.sr}-${source.article}-${source.lang}-${i}`}
          className="rounded-xl border border-divider p-3"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">
              SR {source.sr} Art. {source.article}
            </span>
            <Chip size="sm" variant="flat">
              {source.lang}
            </Chip>
            <span className="ml-auto text-xs text-foreground-400">
              score {source.score.toFixed(2)}
            </span>
          </div>
          {source.heading !== null && (
            <p className="text-sm text-foreground-500">{source.heading}</p>
          )}
          <button
            type="button"
            className="mt-1 text-sm text-primary underline"
            onClick={() =>
              openUrl(source.eli).catch((error: unknown) =>
                console.error("failed to open URL", error),
              )
            }
          >
            Open on Fedlex
          </button>
        </div>
      ))}
    </aside>
  );
}
