// The play-all back-in-time interstitial (docs/plan.md Phase 18): while the
// machine holds `MachineState.interstitial`, a black screen explains the
// jump — the context line that led to the decision, its prompt, every route
// with its seen mark, the route just finished, and the route now starting
// highlighted. The machine owns the hold (INTERSTITIAL_MS, a press ends it);
// this layer only draws the view. Like the other panels, the decisions are a
// pure export (`interstitialRows`) and the DOM half only applies them.

import type { InterstitialView } from "../machine/types";

/** The heading over the interstitial. */
export const INTERSTITIAL_TITLE = "Back in time to try another route";

/** One route row as drawn. */
export interface InterstitialRowModel {
  readonly label: string;
  /** "now" for the route starting, "finished" for the one just ended. */
  readonly status: "now" | "finished" | "seen" | "unseen";
}

export function interstitialRows(
  view: InterstitialView,
): InterstitialRowModel[] {
  return view.routes.map((route) => ({
    label: route.label,
    status:
      route.routeIdx === view.toRouteIdx
        ? "now"
        : route.routeIdx === view.fromRouteIdx
          ? "finished"
          : route.seen
            ? "seen"
            : "unseen",
  }));
}

const STATUS_TEXT: Record<InterstitialRowModel["status"], string> = {
  now: "now playing",
  finished: "just finished",
  seen: "seen",
  unseen: "",
};

export interface InterstitialLayer {
  render(view: InterstitialView | undefined): void;
  destroy(): void;
}

export function mountInterstitial(root: HTMLElement): InterstitialLayer {
  const doc = root.ownerDocument;
  const panel = doc.createElement("div");
  panel.id = "interstitial";
  panel.hidden = true;
  panel.setAttribute("role", "status");
  root.appendChild(panel);
  let shown: InterstitialView | undefined;

  return {
    render(view) {
      if (view === shown) return;
      shown = view;
      if (view === undefined) {
        panel.hidden = true;
        panel.replaceChildren();
        return;
      }
      const title = doc.createElement("p");
      title.className = "interstitial-title";
      title.textContent = INTERSTITIAL_TITLE;
      const parts: HTMLElement[] = [title];
      if (view.context !== undefined) {
        const context = doc.createElement("p");
        context.className = "interstitial-context";
        context.textContent = `“${view.context}”`;
        parts.push(context);
      }
      const prompt = doc.createElement("p");
      prompt.className = "interstitial-prompt";
      prompt.textContent = view.prompt;
      parts.push(prompt);
      const list = doc.createElement("ol");
      list.className = "interstitial-list";
      for (const row of interstitialRows(view)) {
        const item = doc.createElement("li");
        item.className = `interstitial-row interstitial-${row.status}`;
        const label = doc.createElement("span");
        label.className = "interstitial-label";
        label.textContent = row.label;
        item.appendChild(label);
        const text = STATUS_TEXT[row.status];
        if (text !== "") {
          const status = doc.createElement("span");
          status.className = "interstitial-status";
          status.textContent = text;
          item.appendChild(status);
        }
        list.appendChild(item);
      }
      parts.push(list);
      panel.replaceChildren(...parts);
      panel.hidden = false;
    },
    destroy() {
      panel.remove();
    },
  };
}
