import { describe, it, expect } from "vitest";
import { sseEvent, makeSseStream } from "./sse";

describe("sseEvent — Server-Sent Events line encoding", () => {
  it("encodes a JSON payload as a single SSE data frame ending in a blank line", () => {
    const frame = sseEvent({ phase: "data", message: "hello" });
    expect(frame).toBe(`data: ${JSON.stringify({ phase: "data", message: "hello" })}\n\n`);
  });

  it("escapes embedded newlines safely (no premature frame break)", () => {
    const frame = sseEvent({ message: "line1\nline2" });
    // JSON.stringify turns the newline into the two chars \n, so the frame has exactly one \n\n.
    const blankLineCount = frame.split("\n\n").length - 1;
    expect(blankLineCount).toBe(1);
  });
});

describe("makeSseStream — push-based ReadableStream of SSE frames", () => {
  it("emits each pushed event as an SSE frame and closes on done()", async () => {
    const { stream, emit, close } = makeSseStream();
    emit({ phase: "plan", message: "thinking" });
    emit({ phase: "done", done: true });
    close();

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    expect(out).toContain("thinking");
    expect(out).toContain("\"done\":true");
    // two events => two frame separators
    expect(out.split("\n\n").length - 1).toBe(2);
  });
});
