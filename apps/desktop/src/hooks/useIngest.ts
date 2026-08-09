import { useCallback, useEffect, useRef, useState } from "react";
import { getIngestStatus, postIngest, postIngestStop, streamIngestProgress } from "../lib/api";
import type { IngestStatus } from "../lib/api";

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
          case "done":
            setProgress(null);
            break;
          case "error":
            setError(event.detail);
            setProgress(null);
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
