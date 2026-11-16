// The click rule shared by the overlays that close on a click past their
// box (the Volumes sheet, the confirmation box; docs/plan.md Phase 52
// item 11). A click that follows a drag fires on the common ancestor of
// the press and the release, so a press on a control dragged off the box
// arrives as a click on the scrim. `onScrimClick` hands the listener only
// the clicks whose press began on the element the click landed on, so a
// drag that ends outside the box never reads as a click outside it.

/** The slice of an element `onScrimClick` needs (a DOM element fits). */
export interface ScrimTarget {
  addEventListener(
    type: "pointerdown" | "click",
    listener: (event: { target: unknown }) => void,
    options?: boolean,
  ): void;
}

/**
 * Listens for clicks on `panel`, calling `onClick` for a click whose press
 * started on the same element it landed on (a click with no press seen,
 * as a keyboard activation, passes too).
 */
export function onScrimClick<E extends { target: unknown }>(
  panel: ScrimTarget,
  onClick: (event: E) => void,
): void {
  let pressedOn: unknown = null;
  // Capture phase, so a control that stops the event cannot hide a press.
  panel.addEventListener(
    "pointerdown",
    (event) => {
      pressedOn = event.target;
    },
    true,
  );
  panel.addEventListener("click", (event) => {
    const pressed = pressedOn;
    pressedOn = null;
    if (pressed !== null && pressed !== event.target) return;
    onClick(event as E);
  });
}
