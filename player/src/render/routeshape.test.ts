// The branch map's counts on the shared branch shapes (fixtures/route-shapes.json),
// which `kinetic routes` (converter/kinetic_extract/routes.py) is held to
// as well (converter/tests/test_routes.py; docs/plan.md Phase 57 item 6):
// both lay the tree out from the same resolved decisions, so the map and
// the text outline agents read draw the same decisions, routes, stretches,
// end marks and joins.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Branch, Item } from "../machine/types";
import { layOutStrip } from "./mapmodel";

interface Counts {
  resolved: number;
  decisions: number;
  routes: number;
  stretches: number;
  endings: number;
  joins: number;
}

interface ShapeCase {
  name: string;
  folder?: string;
  items?: string[];
  branches?: Branch[];
  expect: Counts;
}

const REPO = new URL("../../../", import.meta.url);
const SHAPES: { cases: ShapeCase[] } = JSON.parse(
  readFileSync(new URL("fixtures/route-shapes.json", REPO), "utf8"),
);

function manifestOf(shape: ShapeCase): {
  items: Item[];
  branches: Branch[];
} {
  if (shape.folder !== undefined) {
    const manifest = JSON.parse(
      readFileSync(new URL(`${shape.folder}/manifest.json`, REPO), "utf8"),
    );
    return { items: manifest.items, branches: manifest.branches ?? [] };
  }
  return {
    items: (shape.items ?? []).map((id) => ({ id, type: "text", text: id })),
    branches: shape.branches ?? [],
  };
}

function built(shape: ShapeCase): boolean {
  return (
    shape.folder === undefined ||
    existsSync(new URL(`${shape.folder}/manifest.json`, REPO))
  );
}

describe("the branch map's counts on fixtures/route-shapes.json", () => {
  for (const shape of SHAPES.cases) {
    it.skipIf(!built(shape))(shape.name, () => {
      const { items, branches } = manifestOf(shape);
      const strip = layOutStrip(items, branches);
      const counts: Counts = {
        resolved: strip.decisionCount,
        decisions: strip.nodes.length,
        routes: strip.routes.length,
        stretches: strip.runs.length,
        endings: strip.ends.length,
        joins: strip.joins.length,
      };
      expect(counts).toEqual(shape.expect);
    });
  }
});
