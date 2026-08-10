import { Button, Popover, PopoverContent, PopoverTrigger, Progress } from "@heroui/react";
import type { useIngest } from "../hooks/useIngest";
import { t } from "../i18n";

/** Corpus tab body of SettingsModal — same status/progress/start/error
 * behavior as the old CorpusModal, plus stop (with a confirm popover) for a
 * running ingest and immediate re-attach of the progress bar. */
export function CorpusPanel({ ingest }: { ingest: ReturnType<typeof useIngest> }) {
  const { status, progress, running, error, start, stop } = ingest;
  const percent =
    progress !== null && progress.total > 0
      ? Math.round((100 * progress.done) / progress.total)
      : 0;

  return (
    <div className="flex flex-col gap-3">
      {status !== null && (
        <div>
          <h3 className="text-xs font-semibold uppercase text-foreground-500">
            {t("corpus.status")}
          </h3>
          <p className="text-sm">{`${status.acts} acts · ${status.chunksTotal} articles · ${
            progress !== null && progress.phase === "embed" ? progress.done : status.chunksEmbedded
          } embedded`}</p>
        </div>
      )}
      {status !== null && status.chunksTotal === 0 && (
        <p className="text-sm text-warning-700">{t("corpus.empty")}</p>
      )}
      {progress !== null && (
        <Progress
          aria-label="Ingest progress"
          value={percent}
          label={`${progress.phase} · ${percent}%`}
          size="sm"
        />
      )}
      {error !== null && <p className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button color="primary" isDisabled={running} onPress={() => void start()}>
          {t("corpus.run")}
        </Button>
        {running && <span className="text-xs text-foreground-400">{t("corpus.running")}</span>}
        {running && (
          <Popover placement="top">
            <PopoverTrigger>
              <Button color="danger" variant="flat" className="ml-auto">
                {t("corpus.stop")}
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex flex-col gap-2 p-2">
                <p className="max-w-56 text-sm">{t("corpus.stopConfirm")}</p>
                <Button size="sm" color="danger" className="self-end" onPress={() => void stop()}>
                  {t("corpus.stop")}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <p className="text-xs text-foreground-400">{t("corpus.chatUsable")}</p>
    </div>
  );
}
