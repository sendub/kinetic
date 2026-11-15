import { describe, expect, it } from "vitest";
import {
  appendPlan,
  resumePlan,
  STREAM_MORE_MS,
  streamPosition,
} from "./spokenstream";

// The arithmetic of a streamed spoken line (docs/plan.md Phase 52 item 4b):
// its chunks are played back to back on the context's clock. The stream has
// a timeline of its own, the chunks' seconds joined; `base` is the context
// time at which that timeline's 0 falls while it plays.

describe("resumePlan: where each chunk goes when the stream plays from a place", () => {
  it("places the chunks back to back from the start", () => {
    expect(resumePlan([1, 2, 1.5], 0, 10)).toEqual({
      base: 10,
      placements: [
        { index: 0, when: 10, offset: 0 },
        { index: 1, when: 11, offset: 0 },
        { index: 2, when: 13, offset: 0 },
      ],
    });
  });

  it("resumes inside a chunk: it starts at once from its offset, the rest follow it", () => {
    const plan = resumePlan([1, 2, 1.5], 1.5, 20);
    expect(plan.base).toBeCloseTo(18.5, 9);
    expect(plan.placements).toHaveLength(2);
    expect(plan.placements[0]).toMatchObject({ index: 1, offset: 0.5 });
    expect(plan.placements[0]?.when).toBeCloseTo(20, 9);
    expect(plan.placements[1]).toMatchObject({ index: 2, offset: 0 });
    expect(plan.placements[1]?.when).toBeCloseTo(21.5, 9);
  });

  it("resumes on a seam: the chunk that ended is not played again", () => {
    const plan = resumePlan([1, 2], 1, 5);
    expect(plan.placements).toEqual([{ index: 1, when: 5, offset: 0 }]);
  });

  it("places nothing when every chunk so far was played (a stream waiting for more)", () => {
    expect(resumePlan([1, 2], 3, 5)).toEqual({ base: 2, placements: [] });
    expect(resumePlan([], 0, 5)).toEqual({ base: 5, placements: [] });
  });
});

describe("appendPlan: where a chunk that arrives while the stream plays goes", () => {
  it("starts it where the last scheduled chunk ends, so the two play back to back", () => {
    expect(appendPlan(10, 3, 11)).toEqual({ base: 10, when: 13 });
  });

  it("starts a late chunk at once and moves the timeline, so what follows still joins it", () => {
    expect(appendPlan(10, 3, 15)).toEqual({ base: 12, when: 15 });
    // The next one then follows the late one.
    expect(appendPlan(12, 5, 15.5)).toEqual({ base: 12, when: 17 });
  });

  it("a chunk that arrives exactly as the last ends is on time", () => {
    expect(appendPlan(10, 3, 13)).toEqual({ base: 10, when: 13 });
  });
});

describe("streamPosition: where the stream stands", () => {
  it("is the time since its start, held within what has arrived", () => {
    expect(streamPosition(10, 3, 12)).toBe(2);
    expect(streamPosition(10, 3, 9)).toBe(0);
    expect(streamPosition(10, 3, 20)).toBe(3);
  });
});

describe("STREAM_MORE_MS", () => {
  it("is a wait well past a chunk's usual gap", () => {
    expect(STREAM_MORE_MS).toBeGreaterThanOrEqual(10_000);
  });
});
