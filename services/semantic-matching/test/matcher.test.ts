/**
 * Prompt 9.1 exit criterion (build-roadmap.md's Phase 9 section):
 * "Matching quality validated against a labeled test set of realistic
 * skill descriptions, not just 'it returns something'." Every case
 * below is a realistic free-text skill description (concept.md
 * section 10's own example: "I know React and I've done some Figma
 * work") paired with the specific project it must rank first among a
 * set of plausible-but-wrong distractors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initEmbedder } from "../src/embedder.js";
import { _resetAllIndexesForTests, match, matchCandidates, reindex } from "../src/matcher.js";

beforeAll(async () => {
  await initEmbedder();
}, 30_000);

const PROJECTS = [
  { id: "website-revamp", text: "Redesign the nonprofit's website using React, needs UI/UX design in Figma" },
  { id: "shelter-build", text: "Build wooden shelters for the community garden, carpentry and power tools needed" },
  { id: "first-aid-workshop", text: "Teach a community first aid and CPR certification class for new volunteers" },
  { id: "grant-writing", text: "Draft grant proposals and fundraising letters for the annual campaign" },
  { id: "food-bank-sort", text: "Sort and pack donated groceries at the weekend food bank distribution" },
  { id: "translation-help", text: "Translate outreach flyers from English to Spanish for the health clinic" },
];

const LABELED_SKILLS: Array<{ skill: string; expectedTopMatch: string }> = [
  { skill: "I know React and I've done some Figma design work", expectedTopMatch: "website-revamp" },
  { skill: "Experienced carpenter, comfortable with power tools and building structures", expectedTopMatch: "shelter-build" },
  { skill: "Certified first aid and CPR trainer with hospital experience", expectedTopMatch: "first-aid-workshop" },
  { skill: "I've written successful grant applications for two other nonprofits", expectedTopMatch: "grant-writing" },
  { skill: "Happy to do physical warehouse work, sorting and packing boxes", expectedTopMatch: "food-bank-sort" },
  { skill: "Fluent in Spanish and English, professional translation experience", expectedTopMatch: "translation-help" },
];

describe("labeled skill-to-project matching quality", () => {
  beforeAll(async () => {
    await reindex("projects", PROJECTS);
  }, 30_000);

  it.each(LABELED_SKILLS)(
    "ranks '$expectedTopMatch' first for a realistic matching skill description",
    async ({ skill, expectedTopMatch }) => {
      const results = await match("projects", skill, 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(expectedTopMatch);
    },
  );

  it("ranks results best-first by descending similarity", async () => {
    const results = await match("projects", LABELED_SKILLS[0].skill, PROJECTS.length);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});

describe("matchCandidates (the hours-suggestion use case's ad-hoc ranking)", () => {
  it("ranks a caller-supplied candidate set without needing a pre-built index", async () => {
    const results = await matchCandidates(
      "I know React and I've done some Figma design work",
      PROJECTS.slice(0, 2), // only website-revamp and shelter-build as "candidates"
      2,
    );
    expect(results[0].id).toBe("website-revamp");
  });

  it("never returns an id outside the supplied candidate set", async () => {
    const results = await matchCandidates("first aid and CPR", PROJECTS.slice(0, 2), 10);
    for (const r of results) {
      expect(["website-revamp", "shelter-build"]).toContain(r.id);
    }
  });
});

describe("an un-indexed or emptied collection", () => {
  it("returns no results rather than throwing", async () => {
    _resetAllIndexesForTests();
    const results = await match("volunteers", "anything", 5);
    expect(results).toEqual([]);
  });

  it("returns no results after reindexing with an empty item list", async () => {
    await reindex("projects", []);
    const results = await match("projects", "anything", 5);
    expect(results).toEqual([]);
  });
});
