// Route announcements (docs/plan.md Phase 16, Branches): make a branch
// journey legible with the shell's `#flash` pill — "Route: <label>" when a
// route becomes current (a manual pick OR a play-all auto-pick), and, when
// the journey jumped BACK in time to take it, "Back to try another route"
// first. The machine is unchanged: a route entry is observed as a state
// transition — the innermost open route frame appears or changes, and the
// cursor lands on that route's first item, which is exactly what
// `enterRoute` does (`choose`, auto-pick). Navigating across route items
// (wheel, `e`, `goTo`) changes no frame, so it announces nothing; a
// bookmark restore landing mid-route announces nothing either, and one
// landing exactly on a route's first item simply names where the reader
// now is.

import type { Machine } from "../machine/machine";
import type { ContextFrame, Manifest } from "../machine/types";

/** The pill shown when the journey jumps back to take another route. */
export const BACK_JUMP_MESSAGE = "Back to try another route";

/** The pill naming the route the reader has just entered. */
export function routeFlashLabel(label: string): string {
  return `Route: ${label}`;
}

/** What one state snapshot says about the route context. */
export interface RouteObservation {
  readonly cursor: number;
  /** The innermost open frame, or null at the top level. */
  readonly frame: ContextFrame | null;
}

/**
 * Every route's FIRST item index mapped to its label. A route entry always
 * lands on its first item, so this is the announcement lookup; an index is
 * at most one route's start (route spans tile their region).
 */
export function routeStartLabels(
  manifest: Manifest,
): ReadonlyMap<number, string> {
  const labels = new Map<number, string>();
  const branches = manifest.branches ?? [];
  if (branches.length === 0) return labels;
  const byId = new Map<string, number>();
  manifest.items.forEach((item, index) => {
    if (!byId.has(item.id)) byId.set(item.id, index);
  });
  for (const branch of branches) {
    for (const route of branch.routes) {
      const start = byId.get(route.start);
      if (start !== undefined) labels.set(start, route.label);
    }
  }
  return labels;
}

function sameFrame(a: ContextFrame | null, b: ContextFrame | null): boolean {
  return (
    a !== null && b !== null && a.decision === b.decision && a.route === b.route
  );
}

/**
 * The pills to show as the route context moves from `prev` to `next`:
 * nothing unless a frame appeared or changed (a route became current) AND
 * the cursor sits on that route's first item — the entry `enterRoute`
 * makes. A backward cursor on such an entry is a jump back in time, so the
 * "Back to try another route" pill comes first; the route pill follows.
 */
export function routeAnnouncementsFor(
  prev: RouteObservation,
  next: RouteObservation,
  labels: ReadonlyMap<number, string>,
): readonly string[] {
  if (next.frame === null || sameFrame(prev.frame, next.frame)) return [];
  const label = labels.get(next.cursor);
  if (label === undefined) return [];
  const route = routeFlashLabel(label);
  return next.cursor < prev.cursor ? [BACK_JUMP_MESSAGE, route] : [route];
}

export interface RouteAnnouncementsOptions {
  machine: Machine;
  manifest: Manifest;
  /** Show the pills, in order: the next only after the former has shown. */
  flash(messages: readonly string[]): void;
}

/**
 * Watch the machine for route entries and announce them. Returns the
 * unsubscribe. The observation is seeded at mount, so a load (or a
 * resume) never announces.
 */
export function mountRouteAnnouncements({
  machine,
  manifest,
  flash,
}: RouteAnnouncementsOptions): () => void {
  const labels = routeStartLabels(manifest);

  function observe(): RouteObservation {
    const stack = machine.exportContext().stack;
    const top = stack[stack.length - 1];
    return { cursor: machine.getState().cursor, frame: top ?? null };
  }

  let previous = observe();
  return machine.subscribe(() => {
    const next = observe();
    const messages = routeAnnouncementsFor(previous, next, labels);
    previous = next;
    if (messages.length > 0) flash(messages);
  });
}
