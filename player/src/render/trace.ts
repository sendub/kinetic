// The item trace for tests (docs/plan.md Phase 54, item 1). A test that
// must know every screen the player showed, in order, cannot get it from
// the state writes (they coalesce during a skip burst) nor by polling the
// stage's `data-item` (a poll misses a burst's items). So a page that sets
// `window.KINETIC_TEST_TRACE = true` before the player starts gets a
// record of each, appended to `window.__kineticTrace` (an array the player
// creates) and dispatched on `document` as a `kinetic:item` CustomEvent
// whose `detail` is the same record, frozen, plain JSON:
//
// - `item`: one per machine arrival (`Machine.arrival()`, its number
//   changing; a re-emit gives none, nor does a video's segment step, which
//   is no arrival), with the item's id and type and the arrival's kind.
// - `choice`: each time a choice screen opens (a new arrival's, a choice
//   appearing on the same item, or a different decision's), with the
//   decision, the route ids offered in order, whether the return row is
//   offered, Play all is answering it (`autoPick`) and the wheel walked
//   onto it (`walked`).
// - `end`: each time the end card shows.
//
// Every record carries `n` (from 0 per page load over all records, so a
// gap shows), `itemId`, `routeStack` (the open routes, outermost first, as
// the saved state's `{ decision, route }` ids), `playAll` and `skipping`.
// Within one state change an item record comes before its choice or end
// record. The load's screen is recorded at once, as the first arrival.
//
// The array holds at most TRACE_CAP records; past that a record is not
// appended but still gets its `n` and its event, and
// `window.__kineticTraceDropped` (0 at start) counts it. A reader may
// empty the array (`length = 0`) to make room, or reset the counter: the
// player keeps appending to the same array and adds to the counter as it
// finds it.
//
// The flag is read once, at mount. Without it the player subscribes
// nothing and defines no globals, so normal play pays nothing; with it the
// trace only reads the machine, after the other subscribers (main.ts), so
// nothing is heard or timed differently. The game apps never set it.

import type { Machine } from "../machine/machine";
import type { ArrivalKind, Item, MachineState } from "../machine/types";
import type { ContextCodec } from "../storage/ids";

/** The most records the array holds before it counts drops instead. */
export const TRACE_CAP = 200_000;

/** The event each record is dispatched as, on `document`. */
export const TRACE_EVENT = "kinetic:item";

/** An open route, by id, as the saved state holds it. */
export interface TraceFrame {
  readonly decision: string;
  readonly route: string;
}

interface TraceCommon {
  readonly n: number;
  readonly itemId: string;
  readonly routeStack: readonly TraceFrame[];
  readonly playAll: boolean;
  readonly skipping: boolean;
}

export interface TraceItemRecord extends TraceCommon {
  readonly kind: "item";
  readonly type: Item["type"];
  readonly arrival: ArrivalKind;
}

export interface TraceChoiceRecord extends TraceCommon {
  readonly kind: "choice";
  readonly decisionId: string;
  readonly routes: readonly string[];
  readonly returnRow: boolean;
  readonly autoPick: boolean;
  readonly walked: boolean;
}

export interface TraceEndRecord extends TraceCommon {
  readonly kind: "end";
}

export type TraceRecord = TraceItemRecord | TraceChoiceRecord | TraceEndRecord;

/** A record before it is numbered. */
type Unnumbered<T> = T extends TraceRecord ? Omit<T, "n"> : never;

/** What the trace reads and writes of the page's window. */
export interface TraceWindow {
  KINETIC_TEST_TRACE?: unknown;
  __kineticTrace?: TraceRecord[];
  __kineticTraceDropped?: number;
  readonly document: Pick<EventTarget, "dispatchEvent">;
}

export interface TraceOptions {
  win: TraceWindow;
  machine: Machine;
  items: readonly Item[];
  codec: ContextCodec;
  /** The Play all routes setting in force. */
  playAll(): boolean;
}

/**
 * Trace every arrival, choice screen and end card when the page set
 * `KINETIC_TEST_TRACE` to true (see the header). Returns the unsubscribe,
 * or null, having touched nothing, when the flag is unset.
 */
export function mountTrace({
  win,
  machine,
  items,
  codec,
  playAll,
}: TraceOptions): (() => void) | null {
  if (win.KINETIC_TEST_TRACE !== true) return null;
  const records: TraceRecord[] = [];
  win.__kineticTrace = records;
  win.__kineticTraceDropped = 0;
  let n = 0;
  let arrival = -1;
  let choiceOpen: string | null = null;
  let endShown = false;

  const push = (record: Unnumbered<TraceRecord>): void => {
    const frozen = Object.freeze({ n, ...record }) as TraceRecord;
    n += 1;
    if (records.length < TRACE_CAP) records.push(frozen);
    else win.__kineticTraceDropped = (win.__kineticTraceDropped ?? 0) + 1;
    win.document.dispatchEvent(
      new CustomEvent(TRACE_EVENT, { detail: frozen }),
    );
  };

  const observe = (state: MachineState): void => {
    const now = machine.arrival();
    const arrived = now.number !== arrival;
    arrival = now.number;
    const choice = state.choice;
    const opens =
      choice !== undefined && (arrived || choiceOpen !== choice.decisionId);
    const ends = state.endCard !== undefined && (arrived || !endShown);
    choiceOpen = choice?.decisionId ?? null;
    endShown = state.endCard !== undefined;
    if (!arrived && !opens && !ends) return;

    const item = items[state.cursor];
    // Read once per change that records, never on a plain re-emit; the
    // place is bounded by the manifest's decisions, not by what was read.
    const place = machine.exportPlace();
    // After each kind's own fields: a record reads n, kind, itemId, its
    // own fields, then these.
    const common = {
      routeStack: Object.freeze(
        codec
          .toSaved(place)
          .stack.map((frame) =>
            Object.freeze({ decision: frame.decision, route: frame.route }),
          ),
      ),
      playAll: playAll(),
      skipping: state.skipping,
    };
    if (arrived) {
      push({
        kind: "item",
        itemId: item.id,
        type: item.type,
        arrival: now.kind,
        ...common,
      });
    }
    if (opens) {
      push({
        kind: "choice",
        itemId: item.id,
        decisionId: choice.decisionId,
        routes: Object.freeze(choice.routes.map((route) => route.id)),
        returnRow: choice.continueOption === true,
        autoPick: choice.autoPick !== undefined,
        walked: machine.walkedChoice(),
        ...common,
      });
    }
    if (ends) push({ kind: "end", itemId: item.id, ...common });
  };

  observe(machine.getState());
  return machine.subscribe(observe);
}
