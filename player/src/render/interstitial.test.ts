import { describe, expect, it } from "vitest";
import type { InterstitialView } from "../machine/types";
import { interstitialRows } from "./interstitial";

describe("interstitialRows (docs/plan.md Phase 18, play-all legibility)", () => {
  it("highlights the route starting, names the one just finished, keeps seen marks", () => {
    const view: InterstitialView = {
      decisionId: "d1",
      prompt: "Which way?",
      routes: [
        { routeIdx: 0, id: "a", label: "A", seen: true },
        { routeIdx: 1, id: "b", label: "B", seen: true },
        { routeIdx: 2, id: "c", label: "C", seen: false },
        { routeIdx: 3, id: "d", label: "D", seen: false },
      ],
      fromRouteIdx: 1,
      toRouteIdx: 2,
    };
    expect(interstitialRows(view)).toEqual([
      { label: "A", status: "seen" },
      { label: "B", status: "finished" },
      { label: "C", status: "now" },
      { label: "D", status: "unseen" },
    ]);
  });
});
