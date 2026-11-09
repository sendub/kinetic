import { describe, expect, it } from "vitest";
import { measureTargetSound, syntheticSoundStory } from "./soundbench";

// The target sound's speed bound (docs/plan.md Phase 47, item 4;
// docs/perf.md "Target sound"): under 1 ms per arrival at p95 on a story of
// 160,000 items, 400 decisions and 5,000 music changes, reading it through
// and jumping about it. Measured p95s sit hundreds of times under the
// bound, so checking the bound itself stays green on a loaded machine;
// `npm run perf:sound` prints the figures.

describe("target sound speed", () => {
  it("resolves each arrival in under 1 ms (p95) on a 160,000-item story", () => {
    const story = syntheticSoundStory();
    expect(story.items).toHaveLength(160_000);
    expect(story.branches).toHaveLength(400);
    const changes = story.items.filter(
      (item) => item.audio?.music !== undefined,
    );
    expect(changes).toHaveLength(5_000);

    const timings = measureTargetSound(story, 2_000);
    expect(timings.reading.arrivals).toBeGreaterThanOrEqual(159_999);
    expect(timings.reading.p95).toBeLessThan(1);
    expect(timings.jumps.p95).toBeLessThan(1);
    // Every arrival here follows a new last pick, so most walk cold.
    expect(timings.repickJumps.p95).toBeLessThan(5);
  }, 60_000);
});
