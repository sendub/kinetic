// The auto-forward pill (docs/plan.md Phase 20): `a` had no visible
// feedback, so every real flip of the mode shows the shell's route pill —
// "Auto-forward on" when it starts, "Auto-forward off" whenever it stops,
// however it stops (`a` again, or the Space that ends auto, alone or ending
// a skip burst, after that burst's "Skip off"). `a` works on a choice
// screen too (docs/plan.md Phase 43), so the pill may show over one. The
// machine is the single source: it reports each flip of its flag
// (`onAutoAdvanceChange`), so a load, a repeat of the current mode, Tab, a
// panel's pause, reaching a choice and the end — none of which changes the
// flag — show nothing. The pill is the route pill (`flashSequence`): same
// look, same 1.6 s hold, and the newest announcement wins.

import { t } from "../i18n/catalogue.ts";
import type { Machine } from "../machine/machine";

/** The pill naming the mode the reader is now in. */
export function autoForwardMessage(on: boolean): string {
  return on ? t("pill.autoForwardOn") : t("pill.autoForwardOff");
}

export interface AutoForwardAnnouncementsOptions {
  machine: Machine;
  /** The shell's route pill: shows the messages in order. */
  flash(messages: readonly string[]): void;
}

/** Announce every auto-forward flip. Returns the unsubscribe. */
export function mountAutoForwardAnnouncements({
  machine,
  flash,
}: AutoForwardAnnouncementsOptions): () => void {
  return machine.onAutoAdvanceChange((on) => {
    flash([autoForwardMessage(on)]);
  });
}
