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
// stack frame or played/completed route of an unknown decision or route is
// dropped, and a history entry naming anything unknown is removed (the
// entry on screen moves to the nearest kept entry at or before it). A
// `lastShown` that is gone falls back to the restored history's landing,
// else the furthest seen item. A save in which nothing resolves at all is
// no save. Pure: no DOM, no storage.

import { resolveDecisions } from "../machine/machine";
import type {
  Branch,
  ContextFrame,
  HistoryEntry,
  Item,
  MachineContext,
} from "../machine/types";
import type {
  PersistedState,
  SavedContext,
  SavedFrame,
  SavedHistoryEntry,
  SavedRouteSet,
} from "./types";

export interface ContextCodec {
  /** The machine's index context as the id-keyed form storage holds. */
  toSaved(context: MachineContext): SavedContext;
  /**
   * A stored id-keyed context as the machine's index context for THIS
   * manifest, with every unknown id dropped (see the header); undefined
   * when nothing in it resolves — no landing item, nothing seen, no
   * history — which the caller treats as no save.
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

  // `exportContext()` hands back the same frozen history array until the
  // history itself changes, and every state change persists the context:
  // converting up to `HISTORY_CAP` entries per write is the cost the
  // machine's own cache exists to avoid, so the converted copy is kept too.
  let historySource: readonly HistoryEntry[] | null = null;
  let historySaved: readonly SavedHistoryEntry[] = [];
  const savedHistory = (
    history: readonly HistoryEntry[],
  ): readonly SavedHistoryEntry[] => {
    if (history === historySource) return historySaved;
    const out: SavedHistoryEntry[] = [];
    for (const entry of history) {
      const item = itemId(entry.index);
      if (item === undefined) continue;
      const stack = entry.stack.map(savedFrame);
      if (stack.some((frame) => frame === undefined)) continue;
      const decision =
        entry.decision === undefined
          ? undefined
          : decisions[entry.decision]?.id;
      if (entry.decision !== undefined && decision === undefined) continue;
      out.push({
        item,
        stack: stack as SavedFrame[],
        ...(decision === undefined ? {} : { decision }),
      });
    }
    historySource = history;
    historySaved = Object.freeze(out);
    return historySaved;
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
        ...(context.history === undefined
          ? {}
          : { history: savedHistory(context.history) }),
        ...(context.historyPos === undefined
          ? {}
          : { historyPos: context.historyPos }),
      };
    },

    fromSaved(saved) {
      const visited = new Set<number>();
      for (const id of saved.visited) {
        const index = itemById.get(id);
        if (index !== undefined) visited.add(index);
      }
      // History: an entry naming anything this manifest lacks is removed
      // whole (its screen cannot be rebuilt), and the entry on screen
      // becomes the last kept entry at or before it — the first kept one
      // when everything before it went.
      const history: HistoryEntry[] = [];
      const stored = saved.history ?? [];
      const onScreen =
        saved.historyPos === undefined
          ? stored.length - 1
          : Math.min(
              Math.max(Math.trunc(saved.historyPos), 0),
              stored.length - 1,
            );
      let historyPos = -1;
      stored.forEach((entry, position) => {
        const index = itemById.get(entry.item);
        if (index === undefined) return;
        const stack: ContextFrame[] = [];
        for (const frame of entry.stack) {
          const resolved = indexFrame(frame);
          if (resolved === undefined) return;
          stack.push(resolved);
        }
        let decision: number | undefined;
        if (entry.decision !== undefined) {
          decision = decisionById.get(entry.decision);
          if (decision === undefined) return;
        }
        history.push({
          index,
          stack,
          ...(decision === undefined ? {} : { decision }),
        });
        if (position <= onScreen) historyPos = history.length - 1;
      });
      if (history.length > 0 && historyPos < 0) historyPos = 0;
      let lastShown = itemById.get(saved.lastShown);
      if (lastShown === undefined && history.length > 0) {
        lastShown = history[historyPos].index;
      }
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
        ...(history.length === 0 ? {} : { history, historyPos }),
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
