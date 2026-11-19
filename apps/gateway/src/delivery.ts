// Sends recorded calls to the ledger service (ADR 0007, PLAN.md "Recording
// delivery rules"). Runs in the background lane, after the response: the
// client stream never waits for it.
//
// V1 is best effort, with everything bounded:
// - the queue holds at most maxPending calls and maxPendingBytes of JSON;
//   a call that does not fit is dropped;
// - each send has a timeout, and a call is retried at most maxAttempts times
//   (network errors, timeouts, 5xx) with growing delays;
// - 400, 401, and 413 are not retried: sending again cannot fix them.
// There is no durable outbox, so pending calls are lost on restart. Every
// drop is counted and logged by call ID, never with content.

import type { RecordedCall } from "@seeit/core";

export type DeliveryOptions = {
  /** Ledger base URL, for example http://127.0.0.1:8788. */
  url: string;
  /** SEEIT_LEDGER_WRITE_TOKEN. */
  token: string;
  maxPending: number;
  maxPendingBytes: number;
  timeoutMs: number;
  maxAttempts: number;
  /** Delay before the first retry; it doubles each time, up to 30 s. */
  retryDelayMs: number;
  /** Sends in flight at once. */
  concurrency: number;
};

export const DEFAULT_DELIVERY = {
  maxPending: 1000,
  maxPendingBytes: 256 * 1024 * 1024,
  timeoutMs: 10_000,
  maxAttempts: 8, // 0.5 + 1 + 2 + 4 + 8 + 16 + 30 s: a ledger restart of about a minute is covered
  retryDelayMs: 500,
  concurrency: 2,
} satisfies Omit<DeliveryOptions, "url" | "token">;

export type Delivery = ReturnType<typeof createDelivery>;

type Pending = { id: string; json: string; bytes: number; attempts: number };

export function createDelivery(
  options: DeliveryOptions,
  deps: { fetch?: typeof fetch; log?: (line: string) => void } = {},
) {
  const send = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const endpoint = new URL("/ingest/calls", options.url).toString();

  const queue: Pending[] = [];
  let queuedBytes = 0; // queued and in flight
  let inFlight = 0;
  let waiting = 0; // calls sleeping before a retry
  let delivered = 0;
  let dropped = 0;
  let idleWaiters: (() => void)[] = [];

  const drop = (p: Pending, reason: string) => {
    dropped++;
    queuedBytes -= p.bytes;
    log(`[delivery] dropped call ${p.id}: ${reason} (${dropped} dropped so far)`);
  };

  const settle = () => {
    if (queue.length === 0 && inFlight === 0 && waiting === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  };

  const pump = () => {
    while (inFlight < options.concurrency && queue.length > 0) {
      const p = queue.shift()!;
      inFlight++;
      void attempt(p).finally(() => {
        inFlight--;
        pump();
        settle();
      });
    }
  };

  async function attempt(p: Pending): Promise<void> {
    p.attempts++;
    let retryable: string;
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: p.json,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      await response.body?.cancel(); // the answer's body is not needed
      // 201 stored, 200 duplicate (an earlier attempt was stored): both delivered.
      if (response.status === 200 || response.status === 201) {
        delivered++;
        queuedBytes -= p.bytes;
        return;
      }
      if (response.status < 500) return drop(p, `ledger rejected it (${response.status})`);
      retryable = `ledger answered ${response.status}`;
    } catch (err) {
      retryable = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "ledger unreachable";
    }
    if (p.attempts >= options.maxAttempts) return drop(p, `${retryable}, after ${p.attempts} attempts`);
    // Back off, then queue it again. The timer must not keep the process alive.
    waiting++;
    const delay = Math.min(options.retryDelayMs * 2 ** (p.attempts - 1), 30_000);
    setTimeout(() => {
      waiting--;
      queue.push(p);
      pump();
    }, delay).unref();
  }

  return {
    /** Queue one call. Returns at once; never throws. */
    send(call: RecordedCall) {
      const json = JSON.stringify(call);
      const bytes = Buffer.byteLength(json);
      const pending = queue.length + inFlight + waiting;
      if (pending >= options.maxPending || queuedBytes + bytes > options.maxPendingBytes) {
        dropped++;
        log(`[delivery] dropped call ${call.id}: queue full (${dropped} dropped so far)`);
        return;
      }
      queuedBytes += bytes;
      queue.push({ id: call.id, json, bytes, attempts: 0 });
      pump();
    },

    /** Counters, for logs and tests. */
    stats() {
      return { delivered, dropped, pending: queue.length + inFlight + waiting };
    },

    /** Resolves when nothing is queued, in flight, or waiting to retry. */
    idle(): Promise<void> {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settle();
      });
    },
  };
}
