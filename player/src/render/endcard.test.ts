import { describe, expect, it } from "vitest";
import { ALL_SEEN_TEXT, endCardText } from "./endcard";

describe("endCardText (docs/plan.md Phase 18, End card)", () => {
  it("counts unplayed routes and points at u", () => {
    expect(
      endCardText({ unseenRoutes: 1, otherUnseen: false, nextUnseen: true }),
    ).toEqual({
      title: "1 route still unseen.",
      hint: "Press u for the next one.",
    });
    expect(
      endCardText({ unseenRoutes: 3, otherUnseen: true, nextUnseen: true })
        .title,
    ).toBe("3 routes and other content still unseen.");
  });

  it("names other unseen content without routes", () => {
    expect(
      endCardText({ unseenRoutes: 0, otherUnseen: true, nextUnseen: true })
        .title,
    ).toBe("Some content is still unseen.");
  });

  it("drops the u line when u has nowhere to go", () => {
    expect(
      endCardText({ unseenRoutes: 2, otherUnseen: false, nextUnseen: false }),
    ).toEqual({ title: "2 routes still unseen." });
  });

  it("says everything has been seen", () => {
    expect(
      endCardText({ unseenRoutes: 0, otherUnseen: false, nextUnseen: false }),
    ).toEqual({ title: ALL_SEEN_TEXT });
  });
});
