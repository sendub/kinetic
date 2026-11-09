// The state write on every change (docs/plan.md Phase 46, storage/
// saves.ts): each write carries the place and the ids seen since the last
// write that went out, taken when it goes out, so the writer's coalescing
// (storage/persist.ts) never drops one.

import { describe, expect, it } from "vitest";

import { createMachine } from "../machine/machine";
import type { Item } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import { createContextCodec } from "./ids";
import { createStateWriter } from "./saves";
import type { PersistedState } from "./types";

const items: Item[] = Array.from({ length: 8 }, (_, n) => ({
  id: `it-${String(n)}`,
  type: "image",
  file: `${String(n)}.jpg`,
}));

/** A storage whose writes finish only when the test says so. */
function heldStorage() {
  const writes: { state: PersistedState; finish: () => void }[] = [];
  return {
    writes,
    seen: () => writes.map((write) => write.state.ctx?.visited ?? null),
    saveState(state: PersistedState): Promise<void> {
      return new Promise((finish) => {
        writes.push({ state, finish: () => finish() });
      });
    },
  };
}

function setup() {
  const machine = createMachine({ items, settings: { ...DEFAULT_SETTINGS } });
  const codec = createContextCodec(items);
  const storage = heldStorage();
  const write = createStateWriter({ storage, machine, codec });
  const record = (): PersistedState => ({
    ctx: codec.toSaved(machine.exportPlace()),
  });
  return { machine, storage, write, record };
}

describe("createStateWriter — the place plus the newly seen ids", () => {
  it("each write carries only what was seen since the last one went out", async () => {
    const { machine, storage, write, record } = setup();
    const first = write(record());
    expect(storage.seen()).toEqual([["it-0"]]);
    storage.writes[0].finish();
    await first;
    machine.advance();
    const second = write(record());
    expect(storage.seen()).toEqual([["it-0"], ["it-1"]]);
    expect(storage.writes[1].state.ctx?.lastShown).toBe("it-1");
    storage.writes[1].finish();
    await second;
    // Nothing new seen: the place alone.
    machine.wheelBack();
    const third = write(record());
    expect(storage.seen()?.[2]).toEqual([]);
    storage.writes[2].finish();
    await third;
    machine.destroy();
  });

  it("ids seen while a write is in flight all ride the write that follows, snapshots replaced or not", async () => {
    const { machine, storage, write, record } = setup();
    const first = write(record()); // it-0, in flight
    machine.advance();
    const second = write(record()); // pending
    machine.advance();
    const third = write(record()); // replaces the pending snapshot
    expect(storage.writes).toHaveLength(1);
    storage.writes[0].finish();
    await first;
    expect(storage.seen()).toEqual([["it-0"], ["it-1", "it-2"]]);
    expect(storage.writes[1].state.ctx?.lastShown).toBe("it-2");
    storage.writes[1].finish();
    await Promise.all([second, third]);
    machine.destroy();
  });

  it("an urgent write beside the one in flight takes the ids since that one", async () => {
    const { machine, storage, write, record } = setup();
    const first = write(record());
    machine.advance();
    const urgent = write(record(), true);
    expect(storage.seen()).toEqual([["it-0"], ["it-1"]]);
    storage.writes[0].finish();
    storage.writes[1].finish();
    await Promise.all([first, urgent]);
    machine.destroy();
  });

  it("a state without a context takes no ids: the next write with one carries them", async () => {
    const { machine, storage, write, record } = setup();
    const bare = write({ helpSeen: true });
    expect(storage.seen()).toEqual([null]);
    storage.writes[0].finish();
    await bare;
    machine.advance();
    const next = write(record());
    expect(storage.seen()?.[1]).toEqual(["it-0", "it-1"]);
    storage.writes[1].finish();
    await next;
    machine.destroy();
  });
});
