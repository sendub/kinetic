// The pure half of the `#choice` decision overlay (docs/plan.md Phase 13):
// the row model drawn from a ChoiceView, the input-ownership precedence,
// and the `0` return hint. The DOM half in choice.ts only applies these; the
// end-to-end screen is walked with the branch fixture (docs/verify-player.md).

import { describe, expect, it } from "vitest";
import type { ChoiceRoute, ChoiceView } from "../machine/types";
import {
  AUTO_PICK_HINT,
  autoPickStatus,
  CHOICE_HINT,
  CONTINUE_LABEL,
  choiceHint,
  choiceRows,
  inputOwnerFor,
} from "./choice";

function route(idx: number, seen = false): ChoiceRoute {
  return {
    routeIdx: idx,
    id: `r${String(idx)}`,
    label: `Route ${String(idx)}`,
    seen,
  };
}

function choice(routes: ChoiceRoute[], continueOption = false): ChoiceView {
  return continueOption
    ? { decisionId: "d", prompt: "Which way?", routes, continueOption: true }
    : { decisionId: "d", prompt: "Which way?", routes };
}

describe("choiceRows (the overlay's row model)", () => {
  it("numbers the routes from 1, in manifest order, seen flags through", () => {
    const rows = choiceRows(choice([route(0, true), route(1), route(2, true)]));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.routeIdx)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.label)).toEqual([
      "Route 0",
      "Route 1",
      "Route 2",
    ]);
    expect(rows.map((row) => row.seen)).toEqual([true, false, true]);
    expect(rows.every((row) => row.kind === "route")).toBe(true);
  });

  it("numbers a tenth row but leaves it keyless (nine keys is all there are)", () => {
    const rows = choiceRows(
      choice(Array.from({ length: 10 }, (_, i) => route(i))),
    );
    expect(rows[9]?.number).toBe(10);
    expect(rows[9]?.kind).toBe("route"); // clickable regardless
  });

  it("appends the Continue row only when the offer is up", () => {
    const bare = choiceRows(choice([route(0), route(1)]));
    expect(bare.some((row) => row.kind === "continue")).toBe(false);

    const rows = choiceRows(choice([route(0), route(1)], true));
    const last = rows[rows.length - 1];
    expect(last).toEqual({
      kind: "continue",
      routeIdx: -1,
      number: 0, // its key: the return row is picked with 0
      label: CONTINUE_LABEL,
      seen: false,
    });
    // The routes keep their numbers under the offer.
    expect(rows.slice(0, 2).map((row) => row.number)).toEqual([1, 2]);
  });

  it("draws nothing without a pending decision", () => {
    expect(choiceRows(undefined)).toEqual([]);
  });
});

describe("inputOwnerFor (help wins; a pending choice owns the rest)", () => {
  it("the key help wins over everything, a pending choice included", () => {
    expect(inputOwnerFor(true, true)).toBe("help");
    expect(inputOwnerFor(true, false)).toBe("help");
  });

  it("a pending choice owns the input over the story", () => {
    expect(inputOwnerFor(false, true)).toBe("choice");
  });

  it("with neither up, the story reads", () => {
    expect(inputOwnerFor(false, false)).toBe("story");
  });
});

describe("choiceHint (docs/plan.md Phase 18: the 0 hint follows the row)", () => {
  // The user had read a return hint on overlays where nothing answered
  // it. The hint's return half renders only when the return row — which
  // itself requires a completed continuing route — is drawn; its key is 0
  // (Enter is no longer a key anywhere: "Key help simplified").
  it("mentions 0 only when the return row is drawn, and never Enter", () => {
    const bare = choiceHint(choice([route(0), route(1)]));
    expect(bare).toBe("1-9 or click picks a route");
    expect(bare).not.toContain("0 returns");
    const withReturn = choiceHint(choice([route(0), route(1)], true));
    expect(withReturn).toBe("1-9 or click picks a route · 0 returns");
    expect(withReturn).not.toContain("Enter");
  });
});

describe("the play-all auto-pick on the choice screen (docs/plan.md Phase 18)", () => {
  const base = { routeIdx: 1, ms: 3000, armId: 1 };
  it("counts down in whole seconds, then names the pick", () => {
    expect(autoPickStatus({ ...base, picked: false }, "Route 2", 3)).toBe(
      "Play all routes picks in 3 s",
    );
    expect(autoPickStatus({ ...base, picked: true }, "Route 2", 0)).toBe(
      "Play all routes picked Route 2",
    );
  });

  it("leads with the jump back on a re-offer", () => {
    expect(
      autoPickStatus(
        { ...base, picked: false, backFromLabel: "Route 1" },
        "Route 2",
        2,
      ),
    ).toBe("Back in time: Route 1 done. Play all routes picks in 2 s");
  });

  it("the hint offers Space only while counting down", () => {
    const view = {
      decisionId: "d",
      prompt: "?",
      routes: [],
    };
    expect(choiceHint({ ...view, autoPick: { ...base, picked: false } })).toBe(
      CHOICE_HINT + AUTO_PICK_HINT,
    );
    expect(choiceHint({ ...view, autoPick: { ...base, picked: true } })).toBe(
      CHOICE_HINT,
    );
  });
});
