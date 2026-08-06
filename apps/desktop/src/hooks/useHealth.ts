import { useEffect, useState } from "react";
import { getHealth } from "../lib/api";

const POLL_INTERVAL_MS = 5000;

/** Polls GET /health; true once the retrieval API answers ok. */
export function useHealth(): boolean {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      const ok = await getHealth();
      if (!cancelled) setOnline(ok);
    }
    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return online;
}
