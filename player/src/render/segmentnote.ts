// The segment note (docs/plan.md Phase 49, item 5; docs/content-format.md
// "Video segments"): each step to a video segment — by Space, Right or
// Left — shows "View n of m" for a moment, n counting from 1 in the item's
// `segments`. It is the shell's pill (`flashSequence`), the look and the
// ~1.6 s hold (ROUTE_PILL_MS) of the route and mode pills: dark glass under
// light text, readable over any video, outside `#overlay` so `h` leaves it
// alone as it leaves every pill, `pointer-events: none` so it blocks no
// input, and not part of a bookmark's thumbnail (render/capture.ts paints
// the stage's visual element alone). A new step's note replaces one still
// showing (the pill's newest-wins rule); leaving the item lets the note
// fade as a route pill does.
//
// The machine is the single source: a step is a change of
// `MachineState.segment` to an index other than the one before on the same
// arrival. A key that steps nothing emits nothing, and every other emit
// (a pause, a setting, an arrival, which clears the segment) keeps or
// drops the segment without a step, so none of them shows a note.

import { t } from "../i18n/catalogue.ts";
import type { Machine } from "../machine/machine";
import type { SegmentView } from "../machine/types";

/** The note's words for the active segment. */
export function segmentNoteText(view: SegmentView): string {
  return t("pill.segment", { index: view.index + 1, count: view.count });
}

export interface SegmentNotesOptions {
  machine: Machine;
  /** The shell's pill: shows the messages in order. */
  flash(messages: readonly string[]): void;
}

/** Show the note on every segment step. Returns the unsubscribe. */
export function mountSegmentNotes({
  machine,
  flash,
}: SegmentNotesOptions): () => void {
  let arrival = machine.arrival();
  let index = machine.getState().segment?.index ?? null;
  return machine.subscribe((state) => {
    const view = state.segment;
    const nextArrival = machine.arrival();
    const next = view?.index ?? null;
    const stepped = next !== index || nextArrival !== arrival;
    arrival = nextArrival;
    index = next;
    if (view !== undefined && stepped) flash([segmentNoteText(view)]);
  });
}
