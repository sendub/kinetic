// The Phase 14 write policy: a change issues its state write immediately,
// and concurrency — not a timer — is what coalesces (storage/persist.ts).
// Two things to prove, and neither needs a browser: the memory adapter shows
// what "no debounce in the write path" means to a caller (the newest record
// is in the store the moment the flush runs, with no timer to advance), and a
// gated fake sink shows the coalescing rule itself, which no real adapter
// would let a test observe — IndexedDB keeps its own transaction timing.

import { describe, expect, it } from "vitest";

import { createMemoryStorage } from "./memory";
import { createImmediateWriter } from "./persist";

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function gate(): Gate {
  const g = {} as Gate;
  g.promise = new Promise<void>((resolve, reject) => {
    g.resolve = resolve;
    g.reject = reject;
  });
  return g;
}

/** A sink that records every call and stays in flight until its gate opens. */
function gatedSink(): {
  calls: number[];
  gates: Gate[];
  write: (value: number) => Promise<void>;
} {
  const calls: number[] = [];
  const gates: Gate[] = [];
  return {
    calls,
    gates,
    write(value: number) {
      calls.push(value);
      const g = gate();
      gates.push(g);
      return g.promise;
    },
  };
}

describe("createImmediateWriter — every change writes now", () => {
  it("issues the write on the caller's own turn, with no timer to wait for", () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    void writer(1);
    // The whole Phase 14 fix in one assertion: the call reaches the sink
    // synchronously, so a reload that starts the next microsecond finds a
    // write already in flight rather than one that was never issued.
    expect(sink.calls).toEqual([1]);
    sink.gates[0].resolve();
  });

  it("keeps only the newest pending snapshot while a write is in flight", async () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    const first = writer(1);
    const second = writer(2); // superseded before it could start
    const third = writer(3);
    expect(sink.calls).toEqual([1]); // nothing else issued while 1 runs
    sink.gates[0].resolve();
    await first;
    // The queue never grew: the burst costs the running write plus the
    // latest, and 2 — stale the moment 3 arrived — was dropped.
    expect(sink.calls).toEqual([1, 3]);
    sink.gates[1].resolve();
    await Promise.all([second, third]);
    expect(sink.calls).toEqual([1, 3]);
  });

  it("resolves a caller when the write carrying its snapshot commits", async () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    let committed = false;
    const first = writer(1).then(() => {
      committed = true;
    });
    sink.gates[0].resolve();
    await first;
    expect(committed).toBe(true);
  });

  it("reports a rejected write to its caller and stays usable for the next change", async () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    const outcome = writer(1).then(
      () => "resolved",
      (error: unknown) => `rejected:${String(error)}`,
    );
    sink.gates[0].reject(new Error("quota"));
    expect(await outcome).toBe("rejected:Error: quota");
    // A failed write is not a stuck writer: the next change is written.
    const next = writer(2);
    expect(sink.calls).toEqual([1, 2]);
    sink.gates[1].resolve();
    await expect(next).resolves.toBeUndefined();
  });

  it("an urgent value is issued at once beside the write in flight (Phase 18)", async () => {
    // Settings survive an immediate reload: a value parked in the pending
    // slot has not been issued, so a reload before the running write
    // commits loses it. Urgent issues it now.
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    const first = writer(1);
    const parked = writer(2); // parked behind 1
    const urgent = writer(3, true);
    expect(sink.calls).toEqual([1, 3]);
    // The parked slot now carries the urgent value, so whatever lands
    // after 3 is never older than 3.
    sink.gates[1].resolve();
    await urgent;
    sink.gates[0].resolve();
    await first;
    expect(sink.calls).toEqual([1, 3, 3]);
    sink.gates[2].resolve();
    await parked;
  });

  it("an urgent value with nothing in flight is an ordinary write", async () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    const first = writer(1, true);
    const second = writer(2); // parks behind it like any other change
    expect(sink.calls).toEqual([1]);
    sink.gates[0].resolve();
    await first;
    expect(sink.calls).toEqual([1, 2]);
    sink.gates[1].resolve();
    await second;
  });

  it("an urgent write reports its own failure", async () => {
    const sink = gatedSink();
    const writer = createImmediateWriter(sink.write);
    const first = writer(1);
    const urgent = writer(2, true).then(
      () => "resolved",
      () => "rejected",
    );
    sink.gates[1].reject(new Error("quota"));
    expect(await urgent).toBe("rejected");
    sink.gates[0].resolve();
    await first;
  });

  it("turns a sink that throws synchronously into a rejected promise, not a throw", async () => {
    const seen: number[] = [];
    const writer = createImmediateWriter((value: number) => {
      seen.push(value);
      if (value === 0) throw new Error("boom");
      return Promise.resolve();
    });
    let caughtAtCallSite = true;
    let outcome = "";
    try {
      // main.ts fires state writes and forgets them: a throw here would
      // surface from the machine's own notification.
      const pending = writer(0);
      caughtAtCallSite = false;
      outcome = await pending.then(
        () => "resolved",
        () => "rejected",
      );
    } catch {
      caughtAtCallSite = true;
    }
    expect({ caughtAtCallSite, outcome }).toEqual({
      caughtAtCallSite: false,
      outcome: "rejected",
    });
  });
});

describe("immediate flush — the newest record is the committed one (Phase 14)", () => {
  it("a flush commits the latest state to the memory adapter, visible at once", async () => {
    const storage = createMemoryStorage();
    const writer = createImmediateWriter(storage.saveState);
    const ctx = (item: string) => ({
      lastShown: item,
      visited: [item],
      stack: [],
      playedRoutes: [],
      completedRoutes: [],
    });
    await writer({ ctx: ctx("a") });
    // The reader keeps moving: a second change arrives while... the memory
    // adapter resolves on the spot, so this is the case the fix is for —
    // there is no debounce window in which the newest position can be lost.
    const inFlight = writer({ ctx: ctx("b") });
    // Not awaited yet, and already the store's record: an immediate reload
    // reads the position the reader is on, not the one before it.
    expect(await storage.loadState()).toMatchObject({
      ctx: { lastShown: "b" },
    });
    await inFlight;
    expect(await storage.loadState()).toMatchObject({
      ctx: { lastShown: "b" },
    });
  });
});
