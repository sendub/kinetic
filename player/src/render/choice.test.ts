// The pure half of the `#choice` decision overlay (docs/plan.md Phase 13):
// the row model drawn from a ChoiceView, the input-ownership precedence,
// and the Enter rule. The DOM half in choice.ts only applies these; the
// end-to-end screen is walked with the branch fixture (docs/verify-player.md).

import { describe, expect, it } from "vitest";
import type { ChoiceRoute, ChoiceView } from "../machine/types";
import {
  CONTINUE_LABEL,
  choiceHint,
  choiceRows,
  enterActionFor,
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
      number: null,
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

describe("enterActionFor (Enter, owned by the screen)", () => {
  it("closes help when help is up — even over a pending choice", () => {
    expect(enterActionFor("help", true)).toBe("close-help");
    expect(enterActionFor("help", false)).toBe("close-help");
  });

  it("takes the return offer when the choice has one", () => {
    expect(enterActionFor("choice", true)).toBe("continue");
  });

  it("is inert with no offer, or with nothing open", () => {
    expect(enterActionFor("choice", false)).toBe("none");
    expect(enterActionFor("story", true)).toBe("none");
    expect(enterActionFor("story", false)).toBe("none");
  });
});

describe("choiceHint (docs/plan.md Phase 18: the Enter hint follows the row)", () => {
  // The user had read "Enter returns" on overlays where nothing answered
  // Enter. The hint's Enter half now renders only when the return row —
  // which itself requires a completed continuing route — is drawn.
  it("mentions Enter only when the return row is drawn", () => {
    const bare = choiceHint(choice([route(0), route(1)]));
    expect(bare).toBe("1-9 or click picks a route");
    expect(bare).not.toContain("Enter");
    const withReturn = choiceHint(choice([route(0), route(1)], true));
    expect(withReturn).toContain("1-9 or click picks a route");
    expect(withReturn).toContain("Enter returns");
  });
});
