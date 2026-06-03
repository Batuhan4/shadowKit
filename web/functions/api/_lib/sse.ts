// Server-Sent Events helpers for the AgentBoard live stream. Each agent step is emitted as one SSE
// `data:` frame carrying a JSON payload; the browser AgentRunPanel reads them with the Streams API.
// Runs on the Cloudflare Workers runtime (ReadableStream + TextEncoder are Web-standard globals).

/** Serialize one event object to a single SSE frame: `data: <json>\n\n`. */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface SseStream {
  /** The body to hand to `new Response(stream, ...)`. */
  stream: ReadableStream<Uint8Array>;
  /** Push one event (encoded as an SSE frame). No-op after close(). */
  emit(payload: unknown): void;
  /** End the stream. */
  close(): void;
}

/** A push-based SSE ReadableStream. emit() enqueues a frame; close() ends it. */
export function makeSseStream(): SseStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  // Buffer events that arrive before the controller is wired (start runs synchronously, but guard
  // against any ordering surprise across runtimes).
  const pending: Uint8Array[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of pending) c.enqueue(chunk);
      pending.length = 0;
    },
  });

  return {
    stream,
    emit(payload: unknown) {
      if (closed) return;
      const chunk = encoder.encode(sseEvent(payload));
      if (controller) controller.enqueue(chunk);
      else pending.push(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      controller?.close();
    },
  };
}

/** Standard SSE response headers (no-cache, keep the connection streaming). */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "access-control-allow-origin": "*",
};
