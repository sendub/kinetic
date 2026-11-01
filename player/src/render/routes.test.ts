// The pure half of the route announcements (docs/plan.md Phase 16,
// Branches): the route-start label lookup, and the transition rule for
// which pills a route entry shows. The wiring in routes.ts only observes
// machine transitions and calls the shell's flash; the demo scenario
// (.tmp/repro-playall.mjs) walks the pills themselves.

import { describe, expect, it } from "vitest";
import type { Branch, Item, Manifest } from "../machine/types";
import {
  BACK_JUMP_MESSAGE,
  routeAnnouncementsFor,
  routeFlashLabel,
  routeStartLabels,
} from "./routes";

function image(id: string): Item {
  return { id, type: "image", file: `${id}.jpg` };
}

// lead | decide | a-1 a-2 | b-1 b-2 | cont-1 | tail
//  0      1       2   3     4   5     6      7
const BRANCHES: readonly Branch[] = [
  {
    id: "d1",
    after: "decide",
    prompt: "Which road?",
    routes: [
      { id: "r-a", label: "Route A", start: "a-1", end: "a-2" },
      { id: "r-b", label: "Turn them down", start: "b-1", end: "b-2" },
      {
        id: "r-c",
        label: "Route C",
        start: "cont-1",
        end: "cont-1",
        result: "return",
      },
    ],
    continuingRoute: "r-c",
    continueAt: "tail",
  },
];

const MANIFEST: Manifest = {
  schemaVersion: 1,
  width: 1280,
  height: 720,
  items: [
    image("lead"),
    image("decide"),
    image("a-1"),
    image("a-2"),
    image("b-1"),
    image("b-2"),
    image("cont-1"),
    image("tail"),
  ],
  branches: BRANCHES,
};

const LABELS = routeStartLabels(MANIFEST);

const frame = (decision: number, route: number) => ({ decision, route });

describe("routeStartLabels (the entry lookup)", () => {
  it("maps every route's first item to its label", () => {
    expect(new Map(LABELS)).toEqual(
      new Map([
        [2, "Route A"],
        [4, "Turn them down"],
        [6, "Route C"],
      ]),
    );
  });

  it("is empty for a linear manifest and skips ids that do not resolve", () => {
    expect(routeStartLabels({ ...MANIFEST, branches: undefined }).size).toBe(0);
    const broken: Manifest = {
      ...MANIFEST,
      branches: [
        {
          id: "d",
          after: "decide",
          prompt: "?",
          routes: [
            { id: "r", label: "Gone", start: "missing", end: "missing" },
            { id: "s", label: "Here", start: "b-1", end: "b-2" },
          ],
        },
      ],
    };
    expect(new Map(routeStartLabels(broken))).toEqual(new Map([[4, "Here"]]));
  });
});

describe("routeAnnouncementsFor (the entry rule)", () => {
  it("a route entered going forward flashes its label once", () => {
    expect(
      routeAnnouncementsFor(
        { cursor: 1, frame: null },
        { cursor: 4, frame: frame(0, 1) },
        LABELS,
      ),
    ).toEqual([routeFlashLabel("Turn them down")]);
  });

  it("a route entered by jumping BACK flashes the jump first", () => {
    expect(
      routeAnnouncementsFor(
        { cursor: 5, frame: frame(0, 1) },
        { cursor: 2, frame: frame(0, 0) },
        LABELS,
      ),
    ).toEqual([BACK_JUMP_MESSAGE, routeFlashLabel("Route A")]);
  });

  it("the same open frame announcing nothing: no re-flash while inside", () => {
    expect(
      routeAnnouncementsFor(
        { cursor: 2, frame: frame(0, 0) },
        { cursor: 3, frame: frame(0, 0) },
        LABELS,
      ),
    ).toEqual([]);
  });

  it("a frame change NOT landing on a route start announces nothing", () => {
    // The continuing route's end pops to `continueAt`, and a bookmark
    // restore lands wherever it was taken — neither is a route entry.
    expect(
      routeAnnouncementsFor(
        { cursor: 6, frame: frame(1, 0) },
        { cursor: 7, frame: frame(0, 2) },
        LABELS,
      ),
    ).toEqual([]);
    expect(
      routeAnnouncementsFor(
        { cursor: 0, frame: null },
        { cursor: 3, frame: frame(0, 0) },
        LABELS,
      ),
    ).toEqual([]);
  });

  it("navigation across a route's first item (no frame change) is silent", () => {
    // `e` and the wheel show route items without entering the route.
    expect(
      routeAnnouncementsFor(
        { cursor: 5, frame: null },
        { cursor: 4, frame: null },
        LABELS,
      ),
    ).toEqual([]);
    expect(
      routeAnnouncementsFor(
        { cursor: 3, frame: frame(0, 0) },
        { cursor: 4, frame: frame(0, 0) },
        LABELS,
      ),
    ).toEqual([]);
  });

  it("a completed decision opening on arrival is silent; the pick from it is not", () => {
    // docs/plan.md Phase 18, bullet 3 widened arrivals to COMPLETED
    // decisions. The pill rule is untouched: an arrival changes no route
    // context (branches.test.ts pins the empty stack), so even landing on a
    // route's first item it says nothing — and the row picked from that view
    // enters the route exactly like a route-end re-selection, which does.
    expect(
      routeAnnouncementsFor(
        { cursor: 5, frame: null },
        { cursor: 2, frame: null }, // the arrival: the overlay opens here
        LABELS,
      ),
    ).toEqual([]);
    expect(
      routeAnnouncementsFor(
        { cursor: 2, frame: null },
        { cursor: 2, frame: frame(0, 0) }, // the pick from that view
        LABELS,
      ),
    ).toEqual([routeFlashLabel("Route A")]);
  });
});

describe("route pills after the play-all interstitial (docs/plan.md Phase 18)", () => {
  it("an entry out of the interstitial shows only the route pill", () => {
    expect(
      routeAnnouncementsFor(
        { cursor: 5, frame: null, interstitial: true },
        { cursor: 2, frame: frame(0, 0) },
        LABELS,
      ),
    ).toEqual([routeFlashLabel("Route A")]);
  });
});
