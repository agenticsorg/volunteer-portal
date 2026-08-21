import { describe, expect, it } from "vitest";
import { isCoursePublishable, findCaptionGateBlocker, type ModuleCaptionState } from "@/modules/training";

// Pure predicate logic for PublishCourse's mandatory caption-approval gate
// (docs/ddd/training-learning.md, Course invariant 3; ADR-0010's explicit
// rejection of unlisted-YouTube-style "publish now, caption later"
// approaches) — no database, per ADR-0015's unit/integration split.
// `publishCourse.ts` (application layer) calls these after loading the
// course's modules/videos. The integration-level negative test lives in
// trainingLifecycle.integration.test.ts; this file isolates the decision
// logic itself.
describe("isCoursePublishable", () => {
  it("a course with zero modules is never publishable", () => {
    expect(isCoursePublishable([])).toBe(false);
  });

  it("a module with no video at all blocks publication", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: null }];
    expect(isCoursePublishable(modules)).toBe(false);
  });

  it("a module whose video captions are still pending blocks publication", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: { captionStatus: "pending" } }];
    expect(isCoursePublishable(modules)).toBe(false);
  });

  it("a module whose video captions are auto_generated (not yet human-approved) blocks publication", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: { captionStatus: "auto_generated" } }];
    expect(isCoursePublishable(modules)).toBe(false);
  });

  it("a module whose video captions are in human_review blocks publication", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: { captionStatus: "human_review" } }];
    expect(isCoursePublishable(modules)).toBe(false);
  });

  it("one approved module out of several unapproved ones still blocks publication", () => {
    const modules: ModuleCaptionState[] = [
      { id: "m1", video: { captionStatus: "approved" } },
      { id: "m2", video: { captionStatus: "auto_generated" } },
    ];
    expect(isCoursePublishable(modules)).toBe(false);
  });

  it("is publishable only once every module's video is approved", () => {
    const modules: ModuleCaptionState[] = [
      { id: "m1", video: { captionStatus: "approved" } },
      { id: "m2", video: { captionStatus: "approved" } },
    ];
    expect(isCoursePublishable(modules)).toBe(true);
  });
});

describe("findCaptionGateBlocker", () => {
  it("returns null when every module is approved", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: { captionStatus: "approved" } }];
    expect(findCaptionGateBlocker(modules)).toBeNull();
  });

  it("returns the first blocking module in array order, ignoring later approved ones", () => {
    const modules: ModuleCaptionState[] = [
      { id: "m1", video: { captionStatus: "approved" } },
      { id: "m2", video: { captionStatus: "auto_generated" } },
      { id: "m3", video: null },
    ];
    expect(findCaptionGateBlocker(modules)?.id).toBe("m2");
  });

  it("returns the videoless module when that's the only blocker", () => {
    const modules: ModuleCaptionState[] = [{ id: "m1", video: null }];
    expect(findCaptionGateBlocker(modules)?.id).toBe("m1");
  });
});
