// The skip pill (docs/plan.md Phase 43), the twin of the auto-forward pill
// (render/autoforward.ts): every real flip of skip mode shows the shell's
// route pill — "Skip on" when Tab starts a burst or arms one on a choice
// screen, "Skip off" whenever it stops, however it stops (Tab again, Space,
// the last seen item, a choice, the end, the wheel, `e`, `u`, a map click or
// a restore, or an armed pick with nothing seen to run through). The
// machine is the single source: it reports each flip (`onSkipChange`), so
// a Tab that does nothing (nothing seen ahead, or where the story ends), a
// panel's pause and a play-all choice a burst carries on through show
// nothing. Same look, same 1.6 s hold, the newest announcement wins.

import type { Machine } from "../machine/machine";

export const SKIP_ON_MESSAGE = "Skip on";
export const SKIP_OFF_MESSAGE = "Skip off";

/** The pill naming the skip mode the reader is now in. */
export function skipMessage(on: boolean): string {
  return on ? SKIP_ON_MESSAGE : SKIP_OFF_MESSAGE;
}

export interface SkipAnnouncementsOptions {
  machine: Machine;
  /** The shell's route pill: shows the messages in order. */
  flash(messages: readonly string[]): void;
}

/** Announce every skip flip. Returns the unsubscribe. */
export function mountSkipAnnouncements({
  machine,
  flash,
}: SkipAnnouncementsOptions): () => void {
  return machine.onSkipChange((on) => {
    flash([skipMessage(on)]);
  });
}
