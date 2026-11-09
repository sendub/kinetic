// The state write the player issues on every change (docs/plan.md Phases
// 14, 46). main.ts hands it the record — the reader's place, its
// `ctx.visited` empty (`codec.toSaved(machine.exportPlace())`), and the
// settings — and this adds the items seen since the previous write, read
// from the machine's seen log (`machine.seenSince`) and converted to ids.
// The storage adapter appends those to the story's seen records
// (storage/idb.ts), so no save carries the whole seen set and every save
// costs about the same however much has been read.
//
// The new ids are taken when the write is ISSUED, not when it is asked
// for: the writer (storage/persist.ts) replaces a pending snapshot with a
// newer one, and the newer one must still carry every item seen since the
// last write that went out. Once handed to the adapter they are its to
// keep: it holds them until a write of them commits.

import type { Machine } from "../machine/machine";
import type { ContextCodec } from "./ids";
import { createImmediateWriter, type ImmediateWriter } from "./persist";
import type { PersistedState, Storage } from "./types";

export function createStateWriter(deps: {
  storage: Pick<Storage, "saveState">;
  machine: Pick<Machine, "seenSince">;
  codec: Pick<ContextCodec, "idsOf">;
}): ImmediateWriter<PersistedState> {
  const { storage, machine, codec } = deps;
  // How much of the machine's seen log has gone to storage.
  let logged = 0;
  const newlySeen = (): string[] => {
    const added = machine.seenSince(logged);
    logged += added.length;
    return codec.idsOf(added);
  };
  return createImmediateWriter((state: PersistedState) =>
    storage.saveState(
      state.ctx === undefined
        ? state
        : { ...state, ctx: { ...state.ctx, visited: newlySeen() } },
    ),
  );
}
