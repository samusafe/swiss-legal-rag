export interface SseFrame {
  event: string;
  data: string;
}

const FRAME_BOUNDARY = /\r?\n\r?\n/;

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/**
 * Incremental SSE parser: feed decoded text chunks split at any byte
 * boundary; complete frames come out once their terminating blank line
 * has arrived.
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";
  return (chunk: string): SseFrame[] => {
    buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = FRAME_BOUNDARY.exec(buffer);
      if (boundary === null) break;
      const frame = parseFrame(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  };
}
