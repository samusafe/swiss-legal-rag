import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestEvent, IngestStatus } from "../lib/api";
import { useIngest } from "./useIngest";

vi.mock("../lib/api", () => ({
  getIngestStatus: vi.fn(),
  postIngest: vi.fn(),
  postIngestStop: vi.fn(),
  streamIngestProgress: vi.fn(),
}));

import { getIngestStatus, postIngest, postIngestStop, streamIngestProgress } from "../lib/api";

const getStatusMock = vi.mocked(getIngestStatus);
const postIngestMock = vi.mocked(postIngest);
const postIngestStopMock = vi.mocked(postIngestStop);
const streamMock = vi.mocked(streamIngestProgress);

const IDLE: IngestStatus = {
  running: false,
  phase: null,
  acts: 10,
  chunksTotal: 12930,
  chunksEmbedded: 12930,
};

async function* events(list: IngestEvent[]): AsyncGenerator<IngestEvent> {
  for (const event of list) yield event;
}

describe("useIngest", () => {
  beforeEach(() => {
    getStatusMock.mockReset();
    postIngestMock.mockReset();
    postIngestStopMock.mockReset();
    streamMock.mockReset();
    getStatusMock.mockResolvedValue(IDLE);
    // A factory (not a shared instance): every call — including the
    // automatic mount-time watch() — gets its own fresh generator, since
    // async generators can't be replayed once drained.
    streamMock.mockImplementation(() => events([]));
  });

  it("loads the status snapshot on mount", async () => {
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).toEqual(IDLE));
    expect(result.current.running).toBe(false);
  });

  it("subscribes to the progress stream immediately on mount, without waiting for the status fetch", async () => {
    let resolveStatus: (() => void) | undefined;
    let statusResolved = false;
    getStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = () => {
            statusResolved = true;
            resolve(IDLE);
          };
        }),
    );
    renderHook(() => useIngest());

    // The SSE stream is already attached even though the status fetch is
    // still pending — the two happen in parallel, not sequentially.
    await waitFor(() => expect(streamMock).toHaveBeenCalled());
    expect(statusResolved).toBe(false);

    resolveStatus?.();
  });

  it("seeds the progress bar from the status snapshot while the first SSE event is still in flight", async () => {
    getStatusMock.mockResolvedValue({
      ...IDLE,
      running: true,
      phase: "embed",
      chunksEmbedded: 6000,
      chunksTotal: 12930,
    });
    // Never yields — simulates the SSE event not having arrived yet.
    streamMock.mockImplementation(
      () =>
        new Promise<never>(() => {
          // never resolves
        }) as unknown as AsyncGenerator<IngestEvent>,
    );

    const { result } = renderHook(() => useIngest());

    await waitFor(() =>
      expect(result.current.progress).toEqual({ phase: "embed", done: 6000, total: 12930 }),
    );
  });

  it("start() posts, tracks progress, then re-syncs on done", async () => {
    postIngestMock.mockResolvedValue(undefined);
    streamMock.mockImplementation(() =>
      events([
        { type: "progress", phase: "embed", done: 5, total: 10 },
        { type: "done", chunksEmbedded: 10 },
      ]),
    );
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.start();
    });

    expect(postIngestMock).toHaveBeenCalledOnce();
    expect(result.current.progress).toBeNull(); // cleared by done
    expect(getStatusMock.mock.calls.length).toBeGreaterThanOrEqual(2); // mount + re-sync
    expect(result.current.error).toBeNull();
  });

  it("surfaces a mid-run error event and stops progress", async () => {
    postIngestMock.mockResolvedValue(undefined);
    streamMock.mockImplementation(() =>
      events([
        { type: "progress", phase: "fetch", done: 1, total: 3 },
        { type: "error", detail: "`ingest fetch` failed (exit 1): BOOM" },
      ]),
    );
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("`ingest fetch` failed (exit 1): BOOM");
    expect(result.current.progress).toBeNull();
  });

  it("surfaces the 409 detail when a run is already active", async () => {
    postIngestMock.mockRejectedValue(new Error("an ingest run is already active"));
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBe("an ingest run is already active");
  });

  it("never surfaces the already-active error on a freshly (re)opened panel", async () => {
    getStatusMock.mockResolvedValue({ ...IDLE, running: true, phase: "embed" });
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.error).toBeNull();
    expect(postIngestMock).not.toHaveBeenCalled();
  });

  it("auto-watches when mounted while a run is active", async () => {
    getStatusMock.mockResolvedValue({ ...IDLE, running: true, phase: "embed" });
    streamMock.mockImplementation(() =>
      events([{ type: "progress", phase: "embed", done: 2, total: 10 }]),
    );
    renderHook(() => useIngest());
    await waitFor(() => expect(streamMock).toHaveBeenCalled());
  });

  it("does not refresh status after unmount aborts the progress stream", async () => {
    getStatusMock.mockResolvedValue({ ...IDLE, running: true, phase: "embed" });
    streamMock.mockImplementation(async function* (signal: AbortSignal) {
      yield { type: "progress", phase: "embed", done: 2, total: 10 } as IngestEvent;
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const { unmount } = renderHook(() => useIngest());
    await waitFor(() => expect(streamMock).toHaveBeenCalled());

    unmount();
    await act(async () => {});

    expect(getStatusMock).toHaveBeenCalledOnce(); // mount snapshot only — no post-abort refresh
  });

  it("stop() calls the stop endpoint", async () => {
    postIngestStopMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    expect(postIngestStopMock).toHaveBeenCalledOnce();
  });

  it("stop() surfaces the 409 detail when no run is active", async () => {
    postIngestStopMock.mockRejectedValue(new Error("no ingest run is active"));
    const { result } = renderHook(() => useIngest());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.error).toBe("no ingest run is active");
  });
});
