// The write policy for the reading-state record (docs/plan.md Phase 14).
// Pure concurrency, no storage and no browser: main.ts hands it a write
// function and calls it on every change.
//
// Why immediate (the Phase 14 bug): a debounced state write is simply
// ABSENT when a reload comes a moment after an advance, and the
// pagehide/visibilitychange flush cannot rescue it — IndexedDB promises
// nothing about a transaction opened while the document goes away, so a
// write that has not been issued yet has no chance at all, and one that is
// already running has at least the chance the flush exists to give. So
// every change issues its write now, and what coalesces is concurrency,
// not timing: at most one write per sink is in flight, and while one runs
// the newest snapshot REPLACES the single pending one. A skip burst costs
// "the write running when the burst started, then the latest" — never a
// queue that grows with the reader's speed.

/**
 * A writer that issues `write(value)` immediately. Resolves when the write
 * carrying `value` commits; rejects with that write's error.
 *
 * `urgent` (docs/plan.md Phase 18, "Settings survive an immediate
 * reload"): issue this value's write NOW even while another is in flight,
 * instead of parking it in the pending slot until that one commits. A
 * parked value has not been issued at all, so a reload a moment later
 * loses it — four quick `+` clicks then a reload came back at 1.00x. The
 * sink must apply writes in issue order (IndexedDB runs readwrite
 * transactions on one store in creation order), and any pending value is
 * replaced by the urgent one, so nothing older can land after it.
 */
export type ImmediateWriter<T> = (value: T, urgent?: boolean) => Promise<void>;

interface Batch<T> {
  value: T;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function newBatch<T>(value: T): Batch<T> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { value, promise, resolve, reject };
}

/**
 * Coalesce `write` to one call in flight plus the latest pending value.
 * A call whose value was superseded shares the newer value's outcome: the
 * record it was waiting for is at least as current as the one it asked for.
 */
export function createImmediateWriter<T>(
  write: (value: T) => Promise<unknown>,
): ImmediateWriter<T> {
  let inFlight = false;
  let pending: Batch<T> | null = null;

  function start(batch: Batch<T>): void {
    inFlight = true;
    let committed: Promise<unknown>;
    try {
      committed = write(batch.value); // issued on the caller's own turn
    } catch (error) {
      committed = Promise.reject(error);
    }
    committed.then(
      () => finish(batch, undefined),
      (error: unknown) => finish(batch, error),
    );
  }

  function finish(batch: Batch<T>, error: unknown): void {
    // Free first, then the pending value, then the caller: a caller
    // resuming from `await` sees a writer ready to take the next change
    // immediately, and a failed write never stops the writer — the next
    // change is simply written again.
    inFlight = false;
    const next = pending;
    pending = null;
    if (next !== null) start(next);
    if (error === undefined) batch.resolve();
    else batch.reject(error);
  }

  /** An extra write beside the one in flight, outside the slot rule. */
  function issueBeside(value: T): Promise<void> {
    const batch = newBatch(value);
    let committed: Promise<unknown>;
    try {
      committed = write(value);
    } catch (error) {
      committed = Promise.reject(error);
    }
    committed.then(batch.resolve, batch.reject);
    return batch.promise;
  }

  return (value: T, urgent = false): Promise<void> => {
    if (inFlight && urgent) {
      // The pending value (if any) is older than this one: it now carries
      // this value too, so when it is issued it rewrites the same record
      // rather than an older one over it.
      if (pending !== null) pending.value = value;
      return issueBeside(value);
    }
    if (inFlight) {
      if (pending === null) pending = newBatch(value);
      else pending.value = value; // the newest snapshot wins the one slot
      return pending.promise;
    }
    const batch = newBatch(value);
    start(batch);
    return batch.promise;
  };
}
