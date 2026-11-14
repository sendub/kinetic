import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "./machine";
import type { Branch, Item, Manifest, Route, RouteResult } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// The validator's unreachable-item warning (tools/validate_content.py,
// `reach_warnings`; docs/plan.md Phase 48 item 6) held to the machine: on
// seeded generated manifests (decisions, nested decisions, every route
// result, continuing routes and pure choices, gaps, joins that land far
// on), the items the validator warns on are exactly the items the machine's
// play-all walk from the opening never shows. One Python process takes the
// whole batch; the CLI's wiring of the warning is tools/
// test_validate_content.py's.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const python = join(repo, ".venv", "bin", "python");

const SEED = 4806;
const MANIFESTS = 400;

/** mulberry32: a small seeded generator, so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a batch of generated manifests exercised, so it cannot go thin. */
interface Coverage {
  nested: number;
  pure: number;
  continuing: number;
  gaps: number;
  farJoins: number;
  results: Record<string, number>;
}

function generate(rand: () => number, coverage: Coverage): Manifest {
  const ids: string[] = [];
  const branches: Branch[] = [];
  const fixups: (() => void)[] = [];
  const int = (low: number, high: number) =>
    low + Math.floor(rand() * (high - low + 1));
  const item = () => {
    ids.push(`i${ids.length}`);
    return ids.length - 1;
  };
  const gap = (chance: number) => {
    if (rand() >= chance) return;
    coverage.gaps += 1;
    for (let n = int(1, 2); n > 0; n -= 1) item();
  };

  function decision(depth: number): void {
    const after = item();
    if (depth > 0) coverage.nested += 1;
    gap(0.15); // between `after` and the first route
    const routeCount = int(2, 4);
    const continuing = rand() < 0.6 ? int(0, routeCount - 1) : -1;
    const choices: (RouteResult | undefined)[] = [
      undefined,
      "ending",
      "return",
      ...(continuing >= 0 ? (["continue"] as const) : []),
    ];
    const routes: Route[] = [];
    for (let r = 0; r < routeCount; r += 1) {
      if (r > 0) gap(0.15); // between two routes
      const start = ids.length;
      sequence(depth + 1);
      const result = choices[int(0, choices.length - 1)];
      coverage.results[result ?? "default"] += 1;
      routes.push({
        id: `r${r}`,
        label: `Route ${r}`,
        start: ids[start],
        end: ids[ids.length - 1],
        ...(result === undefined ? {} : { result }),
      });
    }
    const branch: Branch = {
      id: `d${branches.length}`,
      after: ids[after],
      prompt: "Which?",
      routes,
    };
    branches.push(branch);
    if (continuing < 0) {
      coverage.pure += 1;
      return;
    }
    coverage.continuing += 1;
    branch.continuingRoute = routes[continuing].id;
    gap(0.2); // between the last route end and `continueAt`
    // The next item: a later one in this sequence, past the enclosing
    // route's end (nested routes sharing an ending), or now and then any
    // later item at all, which the validator also accepts.
    const next = ids.length;
    const far = rand() < 0.15;
    if (far) coverage.farJoins += 1;
    fixups.push(() => {
      branch.continueAt = ids[far ? int(next, ids.length - 1) : next];
    });
  }

  function sequence(depth: number): void {
    const nodes = int(1, depth === 0 ? 5 : 3);
    for (let n = 0; n < nodes; n += 1) {
      if (depth < 3 && rand() < 0.45 / (depth + 1)) decision(depth);
      else item();
    }
  }

  item(); // the opening is never a decision's route
  sequence(0);
  item(); // so every `continueAt` has an item to name
  for (const fixup of fixups) fixup();
  const items: Item[] = ids.map((id) => ({
    id,
    type: "image",
    file: `${id}.jpg`,
  }));
  return { schemaVersion: 1, width: 1280, height: 720, items, branches };
}

/** The items the machine's play-all walk from the opening never shows. */
function neverShown(manifest: Manifest): number[] {
  const m = createMachine({
    items: manifest.items,
    branches: manifest.branches,
    settings: { ...DEFAULT_SETTINGS, playAllRoutes: true },
    autoAdvance: false,
  });
  // One press is one step, and takes an auto-pick at once; the walk is
  // over when a press neither moves the cursor nor opens a choice.
  const cap = 20 * manifest.items.length + 100;
  let presses = 0;
  for (; presses < cap; presses += 1) {
    const before = m.getState().cursor;
    m.advance();
    const state = m.getState();
    if (state.cursor === before && state.choice === undefined) break;
  }
  expect(presses, "the play-all walk did not end").toBeLessThan(cap);
  const shown = new Set(m.visitedList());
  m.destroy();
  return manifest.items.map((_, i) => i).filter((i) => !shown.has(i));
}

const VALIDATE = `
import json, re, sys
sys.path.insert(0, "tools")
import validate_content as v
out = []
for manifest in json.load(sys.stdin):
    lines = v.reach_warnings(manifest)
    out.append({
        "problems": v.id_problems(manifest) + v.branches_problems(manifest),
        "warned": [int(re.match(r"warning: manifest\\.json: items\\[(\\d+)\\]",
                                line)[1]) for line in lines],
    })
print(json.dumps(out))
`;

interface Verdict {
  problems: string[];
  warned: number[];
}

/** The validator's problems and warned item indices, one per manifest. */
function validate(manifests: Manifest[]): Verdict[] {
  if (!existsSync(python)) {
    throw new Error(
      `${python} is missing: create the venv (AGENTS.md, "Commands")`,
    );
  }
  const out = execFileSync(python, ["-c", VALIDATE], {
    cwd: repo,
    input: JSON.stringify(manifests),
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.toString()) as Verdict[];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the validator's unreachable items match the machine", () => {
  it(`agree on ${MANIFESTS} generated manifests (seed ${SEED})`, () => {
    vi.useFakeTimers();
    const rand = seeded(SEED);
    const coverage: Coverage = {
      nested: 0,
      pure: 0,
      continuing: 0,
      gaps: 0,
      farJoins: 0,
      results: { default: 0, ending: 0, return: 0, continue: 0 },
    };
    const manifests = Array.from({ length: MANIFESTS }, () =>
      generate(rand, coverage),
    );
    const verdicts = validate(manifests);
    let unshown = 0;
    manifests.forEach((manifest, index) => {
      const never = neverShown(manifest);
      unshown += never.length;
      const where = `manifest ${index} (seed ${SEED}): ${JSON.stringify(manifest)}`;
      expect(verdicts[index].problems, where).toEqual([]);
      expect(verdicts[index].warned, where).toEqual(never);
    });
    // The batch exercised every shape it is meant to.
    expect(unshown).toBeGreaterThan(MANIFESTS / 4);
    expect(coverage.nested).toBeGreaterThan(MANIFESTS / 4);
    expect(coverage.pure).toBeGreaterThan(MANIFESTS / 4);
    expect(coverage.continuing).toBeGreaterThan(MANIFESTS / 4);
    expect(coverage.gaps).toBeGreaterThan(MANIFESTS / 4);
    expect(coverage.farJoins).toBeGreaterThan(MANIFESTS / 20);
    for (const count of Object.values(coverage.results))
      expect(count).toBeGreaterThan(MANIFESTS / 4);
  });
});
