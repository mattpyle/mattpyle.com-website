/**
 * A stream of JSON-RPC responses as a Server-Sent Events body, for `SendStreamingMessage`.
 *
 * A2A 1.0's JSON-RPC binding streams over SSE (specification section 9.4.2): each event is one
 * `data:` line holding a whole JSON-RPC response, and a blank line ends it.
 *
 * **Why it sends comments.** A client's read timeout counts the time between bytes, not the time
 * to the answer: `a2a-sdk` builds its HTTP client with httpx's 5-second default, and httpx applies
 * that to each read of the socket. A turn is quiet for longer than that while the model works. So
 * the body opens with a comment line at once, and a timer sends another every `keepAliveMs`. A
 * line that starts with a colon is an SSE comment: both official clients' parsers drop it, so the
 * caller sees no extra event, and the bytes restart the timeout.
 *
 * The timer is separate from the events. The source may wait on Temporal for longer than the
 * interval, and the comments must keep going while it does.
 *
 * **When the client goes away** the body's `cancel()` runs where the platform reports it. It stops
 * the timer and sets `signal.aborted`, which the source reads between its steps. Where the
 * platform does not report it, the source runs to its own budget and the writes go nowhere.
 *
 * No I/O of its own: a timer and an encoder. Used by src/pages/a2a.ts and by the consultant's
 * test server, so an off-the-shelf client reads the same bytes from both.
 */

/** The headers of the streaming response. `no-transform` and `X-Accel-Buffering` ask proxies not to hold it. */
export const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
});

/** How often a quiet stream sends a comment. Under the 3 seconds the endpoint promises. */
export const KEEP_ALIVE_MS = 2_000;

const OPEN_COMMENT = ': stream open\n\n';
const KEEP_ALIVE_COMMENT = ': keep-alive\n\n';

/** One JSON-RPC response as one SSE event. JSON has no raw newline, so one `data:` line holds it. */
export function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The body of a streaming response.
 *
 * @param {AsyncGenerator<object, any>} events JSON-RPC responses, in order; its return value is
 *   handed to `onEnd`
 * @param {{ signal?: { aborted: boolean }, keepAliveMs?: number,
 *           onEnd?: (result: any, info: { events: number, aborted: boolean, error?: unknown }) => void }} [options]
 * @returns {ReadableStream<Uint8Array>}
 */
export function sseBody(events, { signal = { aborted: false }, keepAliveMs = KEEP_ALIVE_MS, onEnd } = {}) {
  const encoder = new TextEncoder();
  let timer;
  let closed = false;
  const stop = () => {
    closed = true;
    clearInterval(timer);
  };
  return new ReadableStream({
    start(controller) {
      const write = (text) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The consumer is gone and the platform closed the stream under us.
          stop();
          signal.aborted = true;
        }
      };
      write(OPEN_COMMENT);
      timer = setInterval(() => write(KEEP_ALIVE_COMMENT), keepAliveMs);
      // Not awaited: `start` returns at once so the first bytes leave before the source's first step.
      (async () => {
        let count = 0;
        let result;
        let error;
        try {
          for (;;) {
            const next = await events.next();
            if (next.done) {
              result = next.value;
              break;
            }
            count += 1;
            write(sseEvent(next.value));
          }
        } catch (caught) {
          error = caught;
        }
        const wasClosed = closed;
        stop();
        if (!wasClosed) {
          try {
            controller.close();
          } catch {
            // Already closed by the consumer.
          }
        }
        try {
          onEnd?.(result, { events: count, aborted: signal.aborted, ...(error === undefined ? {} : { error }) });
        } catch {
          // The log line is never worth a broken stream.
        }
      })();
    },
    cancel() {
      stop();
      signal.aborted = true;
    },
  });
}
