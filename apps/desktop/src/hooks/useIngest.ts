import { useCallback, useEffect, useRef, useState } from "react";
import { getIngestStatus, postIngest, postIngestStop, streamIngestProgress } from "../lib/api";
import type { IngestStatus } from "../lib/api";
import { logAudit } from "../lib/audit";

export interface IngestProgress {
  phase: string;
  done: number;
  total: number;
}

export function useIngest() {
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await getIngestStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const watch = useCallback(async (): Promise<void> => {
    if (abortRef.current !== null) return; // one progress stream at a time
    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;
    try {
      for await (const event of streamIngestProgress(controller.signal)) {
        switch (event.type) {
          case "progress":
            setProgress({ phase: event.phase, done: event.done, total: event.total });
            break;
          case "done": {
            setProgress(null);
            // Only log ingest.finish when THIS session actually started the
            // run (startRef.current is set by start(), cleared here and on
            // "error"). We deliberately do NOT treat "a progress event
            // arrived on this stream" as sufficient: /ingest/progress emits
            // exactly one progress snapshot even when idle, immediately
            // followed by this terminal event (see app.py's events() loop),
            // so every mount-time reattach — including one that observed
            // nothing running — would still pass a "saw a progress event"
            // check. startRef.current is the only signal that reliably
            // distinguishes "this session started a real run" from "we just
            // reattached to an idle/already-finished stream" (C1).
            if (startRef.current !== null) {
              const elapsed = Math.round(performance.now() - startRef.current);
              logAudit("ingest.finish", { chunks: event.chunksEmbedded }, elapsed);
            }
            startRef.current = null;
            break;
          }
          case "error":
            setError(event.detail);
            setProgress(null);
            // Same guard as "done" above — otherwise a stale state.error on
            // the backend (cleared only by the next start_ingest call) would
            // re-log an identical ingest.error on every reattach for the
            // rest of the API process's life.
            if (startRef.current !== null) {
              logAudit("ingest.error", { message: event.detail });
            }
            startRef.current = null;
            break;
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        failed = true;
        setError(cause instanceof Error ? cause.message : String(cause));
        setProgress(null);
      }
    } finally {
      abortRef.current = null;
    }
    // unmounted/superseded, or the stream itself threw — no post-abort/post-failure
    // refresh (a thrown stream error, unlike a terminal `error` EVENT, doesn't mean
    // the backend run ended, so refetching status would just re-arm the watch effect
    // and hot-loop).
    if (controller.signal.aborted || failed) return;
    await refresh();
  }, [refresh]);

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await postIngest();
      startRef.current = performance.now();
      logAudit("ingest.start", {});
      await watch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [watch]);

  const stop = useCallback(async (): Promise<void> => {
    try {
      await postIngestStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // Fetch the status snapshot AND attach to the progress stream in parallel
  // on mount, rather than waiting for the snapshot to resolve before
  // deciding whether to attach. A panel reopened mid-run then repaints its
  // progress bar as soon as the first SSE event lands instead of after a
  // full status round-trip first — the /ingest/progress endpoint itself
  // is safe to hit unconditionally: idle, it just replies with one snapshot
  // event followed by `done`.
  useEffect(() => {
    void refresh();
    void watch();
    return () => abortRef.current?.abort();
  }, [refresh, watch]);

  const running = (status?.running ?? false) || progress !== null;
  // Bridges the gap between mount and the first SSE progress event for a
  // reattached run: seeds the bar from the status snapshot (which usually
  // resolves first) so it paints immediately, then the real SSE progress
  // event overwrites it with live numbers.
  const displayProgress: IngestProgress | null =
    progress ??
    (status !== null && status.running && status.phase !== null
      ? { phase: status.phase, done: status.chunksEmbedded, total: status.chunksTotal }
      : null);

  return { status, progress: displayProgress, running, error, start, stop };
}
