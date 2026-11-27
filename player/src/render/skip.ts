// The skip pill (docs/plan.md Phase 43), the twin of the auto-forward pill
// (render/autoforward.ts): every real flip of skip mode shows the shell's
// route pill — "Skip on" when Tab starts a burst or arms one on a choice
// screen, "Skip off" whenever it stops, however it stops (Tab again, Space,
// the last seen item, a choice, the end, the wheel, `e`, `u`, a map click or
// a restore, or an armed pick with nothing seen to run through). The
// machine is the single source: it reports each flip (`onSkipChange`), so
// a Tab that does nothing (nothing seen ahead, or where the story ends), a
// panel's pause and a play-all choice a burst carries on through show
// nothing. Same look, same 1.6 s hold, the newest announcement wins. A
// burst that is a shared span's own (Play all routes skipping a span read
// already this pass, `MachineState.readAgain`) shows "Read already:
// skipping" in place of "Skip on"; it ends with the span with no flip, so
// no "Skip off" cuts that pill short, and Space stopping it shows "Skip
// off" as for Tab's.

import { t } from "../i18n/catalogue.ts";
import type { Machine } from "../machine/machine";

/** The pill naming the skip mode the reader is now in. */
export function skipMessage(on: boolean): string {
  return on ? t("pill.skipOn") : t("pill.skipOff");
}

/** The pill over a shared span's own burst: the span was read already. */
export function readAgainMessage(): string {
  return t("pill.readAgain");
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
    const again = on && machine.getState().readAgain === true;
    flash([again ? readAgainMessage() : skipMessage(on)]);
  });
}
