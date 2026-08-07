import { useCallback, useEffect, useRef, useState } from "react";
import { getIngestStatus, postIngest, streamIngestProgress } from "../lib/api";
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

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  // Modal (re)opened while a run is active: reattach to the progress stream.
  const running = (status?.running ?? false) || progress !== null;
  useEffect(() => {
    if (status?.running === true && abortRef.current === null) void watch();
  }, [status, watch]);

  return { status, progress, running, error, start };
}
