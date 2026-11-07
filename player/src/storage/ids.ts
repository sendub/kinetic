// The persistence boundary between positions and ids (docs/plan.md Phase
// 18, "Saves keyed by id, not position"). The machine works in array
// positions — item indices, resolved-decision indices, route indices —
// and `exportContext()` / `importContext()` speak that form. A save must
// survive a content update (a prequel inserted before everything, a new
// mid-story route, a reorder, an extension), so what storage holds is the
// SAME context keyed by stable ids instead: item `id`s, decision
// `branches[].id`s and route `routes[].id`s (`SavedContext`). This module
// converts between the two against one manifest.
//
// Restoring against a manifest the save was not made with drops what no
// longer exists, piece by piece: an unknown item leaves the seen set, a
// stack frame, last pick or played/completed route of an unknown decision or
// route is dropped, and so is an open choice of an unknown decision. A
// `lastShown` that is gone falls back to the furthest seen item. A save in
// which nothing resolves at all is no save. A completed route whose current
// end the reader has not reached, such as one extended since, converts
// as-is; the machine drops that completion on restore (`reachedEnd` in
// machine.ts). Pure: no DOM, no storage.

import { resolveDecisions } from "../machine/machine";
import type {
  Branch,
  ContextFrame,
  Item,
  MachineContext,
} from "../machine/types";
import type {
  PersistedState,
  SavedContext,
  SavedFrame,
  SavedRouteSet,
} from "./types";

export interface ContextCodec {
  /** The machine's index context as the id-keyed form storage holds. */
  toSaved(context: MachineContext): SavedContext;
  /**
   * A stored id-keyed context as the machine's index context for THIS
   * manifest, with every unknown id dropped (see the header); undefined
   * when nothing in it resolves — no landing item, nothing seen — which
   * the caller treats as no save.
   */
  fromSaved(saved: SavedContext): MachineContext | undefined;
}

export function createContextCodec(
  items: readonly Item[],
  branches: readonly Branch[] = [],
): ContextCodec {
  const decisions = resolveDecisions(items, branches);
  const itemById = new Map<string, number>();
  items.forEach((item, index) => {
    if (!itemById.has(item.id)) itemById.set(item.id, index);
  });
  const decisionById = new Map<string, number>();
  for (const decision of decisions) {
    if (!decisionById.has(decision.id))
      decisionById.set(decision.id, decision.index);
  }
  const routeIndex = (decision: number, id: string): number => {
    return decisions[decision].routes.findIndex((route) => route.id === id);
  };

  const itemId = (index: number): string | undefined => items[index]?.id;
  const savedFrame = (frame: ContextFrame): SavedFrame | undefined => {
    const decision = decisions[frame.decision];
    const route = decision?.routes[frame.route];
    return route === undefined
      ? undefined
      : { decision: decision.id, route: route.id };
  };
  const indexFrame = (frame: SavedFrame): ContextFrame | undefined => {
    const decision = decisionById.get(frame.decision);
    if (decision === undefined) return undefined;
    const route = routeIndex(decision, frame.route);
    return route < 0 ? undefined : { decision, route };
  };
  const savedSets = (
    sets: readonly { decision: number; routes: readonly number[] }[],
  ): SavedRouteSet[] => {
    const out: SavedRouteSet[] = [];
    for (const set of sets) {
      const decision = decisions[set.decision];
      if (decision === undefined) continue;
      const routes = set.routes
        .map((route) => decision.routes[route]?.id)
        .filter((id): id is string => id !== undefined);
      out.push({ decision: decision.id, routes });
    }
    return out;
  };
  const indexSets = (
    sets: readonly SavedRouteSet[],
  ): { decision: number; routes: number[] }[] => {
    const out: { decision: number; routes: number[] }[] = [];
    for (const set of sets) {
      const decision = decisionById.get(set.decision);
      if (decision === undefined) continue;
      const routes = set.routes
        .map((id) => routeIndex(decision, id))
        .filter((route) => route >= 0);
      if (routes.length > 0) out.push({ decision, routes });
    }
    return out;
  };

  return {
    toSaved(context) {
      const stack = context.stack
        .map(savedFrame)
        .filter((frame): frame is SavedFrame => frame !== undefined);
      return {
        lastShown: itemId(context.lastShown) ?? "",
        visited: context.visited
          .map(itemId)
          .filter((id): id is string => id !== undefined),
        stack,
        playedRoutes: savedSets(context.playedRoutes),
        completedRoutes: savedSets(context.completedRoutes ?? []),
        ...(context.passRoutes === undefined
          ? {}
          : { passRoutes: savedSets(context.passRoutes) }),
        ...(context.lastPicks === undefined
          ? {}
          : {
              lastPicks: context.lastPicks
                .map(savedFrame)
                .filter((frame): frame is SavedFrame => frame !== undefined),
            }),
        ...(context.choice === undefined ||
        decisions[context.choice] === undefined
          ? {}
          : { choice: decisions[context.choice].id }),
      };
    },

    fromSaved(saved) {
      const visited = new Set<number>();
      for (const id of saved.visited) {
        const index = itemById.get(id);
        if (index !== undefined) visited.add(index);
      }
      let lastShown = itemById.get(saved.lastShown);
      if (lastShown === undefined && visited.size > 0) {
        lastShown = Math.max(...visited);
      }
      if (lastShown === undefined) return undefined;
      return {
        lastShown,
        visited: [...visited].sort((a, b) => a - b),
        stack: saved.stack
          .map(indexFrame)
          .filter((frame): frame is ContextFrame => frame !== undefined),
        playedRoutes: indexSets(saved.playedRoutes),
        completedRoutes: indexSets(saved.completedRoutes),
        ...(saved.passRoutes === undefined
          ? {}
          : { passRoutes: indexSets(saved.passRoutes) }),
        ...(saved.lastPicks === undefined
          ? {}
          : {
              lastPicks: saved.lastPicks
                .map(indexFrame)
                .filter((frame): frame is ContextFrame => frame !== undefined),
            }),
        ...(saved.choice === undefined ||
        decisionById.get(saved.choice) === undefined
          ? {}
          : { choice: decisionById.get(saved.choice) }),
      };
    },
  };
}

/**
 * The machine options that resume a persisted state against this
 * manifest: its id-keyed context converted by `codec`. A null state (the
 * first-ever load), a record without a usable context — including every
 * record written before saves were keyed by id, whose index-based context
 * storage drops at load — and a context in which nothing resolves all
 * resume nothing: a first boot. `createMachine` accepts the result as-is.
 */
export function resumeOptionsFor(
  state: PersistedState | null,
  codec: ContextCodec,
): { resumeContext?: MachineContext } {
  if (state?.ctx === undefined) return {};
  const resumeContext = codec.fromSaved(state.ctx);
  return resumeContext === undefined ? {} : { resumeContext };
}
