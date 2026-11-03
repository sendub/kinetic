// The pure half of the `#choice` decision overlay (docs/plan.md Phase 13):
// the row model drawn from a ChoiceView, the input-ownership precedence,
// and the `0` return hint. The DOM half in choice.ts only applies these; the
// end-to-end screen is walked with the branch fixture (docs/verify-player.md).

import { describe, expect, it } from "vitest";
import type { ChoiceRoute, ChoiceView } from "../machine/types";
import {
  AUTO_PICK_HINT,
  autoPickSeconds,
  autoPickStatus,
  CHOICE_HINT,
  CONTINUE_LABEL,
  choiceHint,
  choiceRows,
  inputOwnerFor,
  LONG_CHOICE_HINT,
  moveCursor,
  scrollIntoListDelta,
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
      pick: "none",
    });
    // The routes keep their numbers under the offer.
    expect(rows.slice(0, 2).map((row) => row.number)).toEqual([1, 2]);
  });

  it("draws nothing without a pending decision", () => {
    expect(choiceRows(undefined)).toEqual([]);
  });
});

describe("the row play-all will pick is marked from the start (docs/plan.md Phase 20)", () => {
  const routes = [route(0, true), route(1), route(2)];
  const auto = { routeIdx: 1, ms: 9000, armId: 1 };
  it("marks the pick 'next' through the whole countdown, the rest 'none'", () => {
    const rows = choiceRows({
      ...choice(routes, true),
      autoPick: { ...auto, picked: false },
    });
    expect(rows.map((row) => row.pick)).toEqual([
      "none",
      "next",
      "none",
      "none",
    ]);
  });

  it("marks it 'picked' once the countdown has run out", () => {
    const rows = choiceRows({
      ...choice(routes),
      autoPick: { ...auto, picked: true },
    });
    expect(rows.map((row) => row.pick)).toEqual(["none", "picked", "none"]);
  });

  it("follows the route on a re-offer", () => {
    const rows = choiceRows({
      ...choice([route(0, true), route(1, true), route(2)]),
      autoPick: {
        ...auto,
        routeIdx: 2,
        picked: false,
        backFromLabel: "Route 1",
      },
    });
    expect(rows.map((row) => row.pick)).toEqual(["none", "none", "next"]);
  });

  it("marks nothing without play-all", () => {
    expect(choiceRows(choice(routes)).every((row) => row.pick === "none")).toBe(
      true,
    );
  });
});

describe("a walked choice screen marks the walk's route (docs/plan.md Phase 27)", () => {
  const routes = [route(0, true), route(1, true), route(2)];
  it("marks the walk route 'next', with or without the return row", () => {
    expect(
      choiceRows({ ...choice(routes, true), walkRoute: 1 }).map(
        (row) => row.pick,
      ),
    ).toEqual(["none", "next", "none", "none"]);
    expect(
      choiceRows({ ...choice(routes), walkRoute: 0 }).map((row) => row.pick),
    ).toEqual(["next", "none", "none"]);
  });

  it("a live play-all pick wins over a walk route", () => {
    expect(
      choiceRows({
        ...choice(routes),
        walkRoute: 0,
        autoPick: { routeIdx: 2, ms: 9000, armId: 1, picked: false },
      }).map((row) => row.pick),
    ).toEqual(["none", "none", "next"]);
  });

  it("keeps the hint: a walked screen counts nothing down", () => {
    expect(choiceHint({ ...choice(routes), walkRoute: 1 })).toBe(CHOICE_HINT);
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
  // (Enter is no key there: "Key help simplified"; only a list past nine
  // routes names it, with the arrows — see the long-list block below).
  it("mentions 0 only when the return row is drawn, and never Enter", () => {
    const bare = choiceHint(choice([route(0), route(1)]));
    expect(bare).toBe("1-9 or click picks a route");
    expect(bare).not.toContain("0 returns");
    const withReturn = choiceHint(choice([route(0), route(1)], true));
    expect(withReturn).toBe("1-9 or click picks a route; 0 returns");
    expect(withReturn).not.toContain("Enter");
  });
});

describe("the play-all auto-pick on the choice screen (docs/plan.md Phase 18)", () => {
  const base = { routeIdx: 1, ms: 3000, armId: 1 };
  it("counts down in whole seconds, rounded up and never under 1", () => {
    expect(autoPickStatus({}, 3)).toBe("Play all routes picks in 3 s");
    expect(autoPickSeconds(false, 2001)).toBe(3);
    expect(autoPickSeconds(false, 2000)).toBe(2);
    expect(autoPickSeconds(false, 1)).toBe(1);
    expect(autoPickSeconds(false, 0)).toBe(1); // no "0 s" as the bar empties
  });

  // Phase 24: the pick changes nothing but the row highlight — the status
  // line (seconds included) and the hint stay as the countdown's last frame
  // left them.
  it("the picked phase shows the same status and hint as the countdown's last frame", () => {
    for (const backFromLabel of [undefined, "Route 1"]) {
      const lead = backFromLabel === undefined ? {} : { backFromLabel };
      const counting = { ...base, ...lead, picked: false };
      const picked = { ...base, ...lead, picked: true, ms: 700, armId: 2 };
      const lastFrame = autoPickStatus(counting, autoPickSeconds(false, 1));
      expect(autoPickStatus(picked, autoPickSeconds(true, 0))).toBe(lastFrame);
      expect(lastFrame).not.toContain("picked");
      const view = { decisionId: "d", prompt: "?", routes: [] };
      expect(choiceHint({ ...view, autoPick: picked })).toBe(
        choiceHint({ ...view, autoPick: counting }),
      );
    }
  });

  it("leads with the jump back on a re-offer", () => {
    expect(autoPickStatus({ backFromLabel: "Route 1" }, 2)).toBe(
      "Back in time: “Route 1” is done. Play all routes picks in 2 s",
    );
  });

  it("the hint offers Space while play-all is about to answer, picked phase included", () => {
    const view = {
      decisionId: "d",
      prompt: "?",
      routes: [],
    };
    expect(choiceHint({ ...view, autoPick: { ...base, picked: false } })).toBe(
      CHOICE_HINT + AUTO_PICK_HINT,
    );
    expect(choiceHint({ ...view, autoPick: { ...base, picked: true } })).toBe(
      CHOICE_HINT + AUTO_PICK_HINT,
    );
    expect(choiceHint(view)).toBe(CHOICE_HINT);
    expect(choiceHint({ ...view, autoPick: { ...base, picked: false } })).toBe(
      "1-9 or click picks a route; Space picks now",
    );
  });
});

describe("long choice lists (more routes than the digits reach)", () => {
  const routes = (n: number) => Array.from({ length: n }, (_, i) => route(i));

  it("the hint names the arrows and Enter only past nine routes", () => {
    expect(choiceHint(choice(routes(9)))).toBe(CHOICE_HINT);
    expect(choiceHint(choice(routes(10)))).toBe(LONG_CHOICE_HINT);
    expect(choiceHint(choice(routes(13), true))).toBe(
      "1-9, arrows and Enter, or click picks a route; 0 returns",
    );
    expect(choiceHint(choice(routes(13)))).not.toContain("·");
  });

  it("every route keeps its own number past nine", () => {
    expect(choiceRows(choice(routes(13))).map((row) => row.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("the cursor starts at the first row going down, the last going up", () => {
    expect(moveCursor(null, 13, "next")).toBe(0);
    expect(moveCursor(null, 13, "prev")).toBe(12);
    expect(moveCursor(null, 0, "next")).toBeNull();
  });

  it("the cursor moves one row and stops at either end", () => {
    expect(moveCursor(0, 13, "next")).toBe(1);
    expect(moveCursor(11, 13, "next")).toBe(12);
    expect(moveCursor(12, 13, "next")).toBe(12);
    expect(moveCursor(1, 13, "prev")).toBe(0);
    expect(moveCursor(0, 13, "prev")).toBe(0);
    // A cursor past a shrunken list restarts at an end.
    expect(moveCursor(20, 3, "next")).toBe(0);
  });

  it("13 presses down reach the 13th row from no cursor", () => {
    let at: number | null = null;
    for (let i = 0; i < 13; i += 1) at = moveCursor(at, 13, "next");
    expect(at).toBe(12);
  });

  describe("scrollIntoListDelta", () => {
    const view = { top: 100, bottom: 400 };
    it("leaves a row already in view alone", () => {
      expect(scrollIntoListDelta(view, { top: 150, bottom: 200 }, 6)).toBe(0);
    });
    it("scrolls down by just enough for a row below the view, margin kept", () => {
      expect(scrollIntoListDelta(view, { top: 500, bottom: 550 }, 6)).toBe(156);
      expect(scrollIntoListDelta(view, { top: 380, bottom: 420 })).toBe(20);
    });
    it("scrolls up for a row above the view", () => {
      expect(scrollIntoListDelta(view, { top: 40, bottom: 90 }, 6)).toBe(-66);
    });
    it("aligns the top of a row taller than the view", () => {
      expect(scrollIntoListDelta(view, { top: 200, bottom: 800 }, 0)).toBe(100);
    });
  });
});
