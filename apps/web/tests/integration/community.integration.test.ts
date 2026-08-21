import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@volunteer-portal/ulid";
import {
  createPost,
  getPostSnapshot,
  getChapterFeed,
  getOrgFeed,
  giveKudos,
  getKudosReceived,
  createTeam,
  joinTeam,
  requestMentorship,
  acceptMentorship,
  searchPosts,
  consumeInboundEvent,
  ScopeInvariantViolationError,
  PersonNotFoundError,
  SelfKudosNotAllowedError,
  AchievementReferenceMismatchError,
  TeamNotFoundError,
  TeamNameTakenError,
  AlreadyTeamMemberError,
  SelfMentorshipNotAllowedError,
  AlreadyHasOpenMentorshipError,
  MentorshipNotRequestedError,
  NotTheMentorError,
  SourceRecordNotFoundError,
  type InboundEvent,
} from "@/modules/community";
import { awardBadge } from "@/modules/gamification";
import { createPerson, createChapterDirect, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject } from "./helpers/volunteeringFixtures";
import { createOpportunityDirect } from "./helpers/volunteeringFixtures";
import { createCourseDirect } from "./helpers/trainingFixtures";

// Exercises the Phase 6 Community & Social application layer end to end
// against a real Postgres. Covers the phase's own completion bar verbatim
// (docs/plans/implementation-plan.md):
//   - "earning a badge (Phase 5) produces a feed entry within one
//     outbox-drain cycle, and that entry's content is unchanged even after
//     the underlying badge definition is later edited" — the core
//     invariant, under "Inbound event consumers" below.
//   - "a chapter-scoped feed query never returns another chapter's
//     restricted posts" — the negative test under "Feed — chapter scope
//     isolation" below.
//   - "getPostSnapshot has its own contract test asserting a stable return
//     shape" — under "getPostSnapshot" below.
describe("Community (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const chapterIds: string[] = [];
  const badgeIds: string[] = [];
  const opportunityIds: string[] = [];
  const courseIds: string[] = [];
  const track = (id: string) => (personIds.push(id), id);

  afterAll(async () => {
    await prisma.communityDomainEvent.deleteMany({});
    await prisma.communityProcessedEvent.deleteMany({});
    await prisma.feedEntry.deleteMany({});
    await prisma.kudos.deleteMany({});
    await prisma.teamMembership.deleteMany({});
    await prisma.team.deleteMany({});
    await prisma.mentorship.deleteMany({});
    await prisma.post.deleteMany({});
    await prisma.gamificationDomainEvent.deleteMany({});
    await prisma.gamificationProcessedEvent.deleteMany({});
    await prisma.badgeAward.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.badge.deleteMany({ where: { id: { in: badgeIds } } });
    await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
    await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
    await prisma.$disconnect();
  });

  async function person(overrides: Partial<{ displayName: string }> = {}) {
    const p = await createPerson(prisma, { displayName: overrides.displayName ?? "Community Test Person" });
    track(p.id);
    return p;
  }

  async function orgAdmin() {
    const p = await person({ displayName: "Community Org Admin" });
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function chapter(name: string) {
    const c = await createChapterDirect(prisma, { name });
    chapterIds.push(c.id);
    return c;
  }

  // ---------------------------------------------------------------------
  describe("CreatePost — scope invariant (Post invariant 1)", () => {
    it("rejects a chapter-scoped post whose scopeId isn't the author's own chapter membership", async () => {
      const chapterA = await chapter("Post Scope Chapter A");
      const chapterB = await chapter("Post Scope Chapter B");
      const author = await person();

      await expect(
        createPost(prisma, {
          caller: callerSubject(author),
          authorChapterId: chapterA.id,
          body: "Trying to post into a chapter I don't belong to.",
          scopeType: "chapter",
          scopeId: chapterB.id, // not the author's own chapter
        }),
      ).rejects.toBeInstanceOf(ScopeInvariantViolationError);
    });

    it("rejects an org-scoped post from a non-org_admin", async () => {
      const author = await person();
      await expect(
        createPost(prisma, {
          caller: callerSubject(author),
          authorChapterId: null,
          body: "Trying to post org-wide without authority.",
          scopeType: "org",
          scopeId: null,
        }),
      ).rejects.toBeInstanceOf(ScopeInvariantViolationError);
    });

    it("allows an org-scoped post from an org_admin, and a chapter-scoped post matching the author's own chapter", async () => {
      const admin = await orgAdmin();
      const orgPost = await createPost(prisma, {
        caller: callerSubject(admin),
        authorChapterId: null,
        body: "An org-wide announcement.",
        scopeType: "org",
        scopeId: null,
      });
      expect(orgPost.postId).toBeTruthy();

      const chapterA = await chapter("Post Scope Chapter Self");
      const member = await person();
      const chapterPost = await createPost(prisma, {
        caller: callerSubject(member),
        authorChapterId: chapterA.id,
        body: "An update for my own chapter.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });
      expect(chapterPost.postId).toBeTruthy();

      const snapshot = await getPostSnapshot(prisma, chapterPost.postId);
      expect(snapshot?.scopeType).toBe("chapter");
      expect(snapshot?.scopeId).toBe(chapterA.id);
    });

    it("throws PersonNotFoundError for an unknown caller", async () => {
      await expect(
        createPost(prisma, {
          caller: { id: newId(), status: "active" },
          authorChapterId: null,
          body: "Ghost post.",
          scopeType: "org",
          scopeId: null,
        }),
      ).rejects.toBeInstanceOf(PersonNotFoundError);
    });
  });

  // ---------------------------------------------------------------------
  describe("Feed — native `kind = 'post'` entries are a live pointer (FeedEntry invariant 2)", () => {
    it("a feed read reflects the post's CURRENT body/status via the live join, not a snapshot taken at write time", async () => {
      const chapterA = await chapter("Live Join Chapter");
      const author = await person();
      const { postId } = await createPost(prisma, {
        caller: callerSubject(author),
        authorChapterId: chapterA.id,
        body: "Original body.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });

      const before = await getChapterFeed(prisma, { chapterId: chapterA.id });
      const entryBefore = before.entries.find((e) => e.sourceId === postId);
      expect(entryBefore?.post?.body).toBe("Original body.");

      // Simulate a later edit directly against the row (no CreatePost-side
      // "edit" use case exists yet in this stage's Build list) — proves the
      // read path re-resolves live, rather than having cached the body into
      // feed_entry.summary/payload at write time (createPost.ts's own doc
      // comment: summary is deliberately NOT the post body).
      await prisma.post.update({ where: { id: postId }, data: { body: "Edited body." } });

      const after = await getChapterFeed(prisma, { chapterId: chapterA.id });
      const entryAfter = after.entries.find((e) => e.sourceId === postId);
      expect(entryAfter?.post?.body).toBe("Edited body.");
    });

    it("a hidden post's native feed entry disappears from feed reads without any feed_entry write", async () => {
      const chapterA = await chapter("Hide Propagation Chapter");
      const author = await person();
      const { postId } = await createPost(prisma, {
        caller: callerSubject(author),
        authorChapterId: chapterA.id,
        body: "About to be hidden.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });

      const feedEntryBeforeHide = await prisma.feedEntry.findFirst({ where: { sourceId: postId, kind: "post" } });
      expect(feedEntryBeforeHide?.hiddenAt).toBeNull();

      await prisma.post.update({ where: { id: postId }, data: { status: "hidden" } });

      const feed = await getChapterFeed(prisma, { chapterId: chapterA.id });
      expect(feed.entries.some((e) => e.sourceId === postId)).toBe(false);

      // And the underlying feed_entry row itself was never touched to
      // achieve that — the Post's own status is the single source of truth
      // for a native entry's visibility (Integration & Anti-Corruption
      // Notes: "no separate feed_entry.hidden_at write needed there").
      const feedEntryAfterHide = await prisma.feedEntry.findUnique({ where: { id: feedEntryBeforeHide!.id } });
      expect(feedEntryAfterHide?.hiddenAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe("Feed — chapter scope isolation (Phase 6 completion bar)", () => {
    it("a chapter-scoped feed query never returns another chapter's restricted posts", async () => {
      const chapterA = await chapter("Isolation Chapter A");
      const chapterB = await chapter("Isolation Chapter B");
      const authorA = await person({ displayName: "Chapter A Author" });
      const authorB = await person({ displayName: "Chapter B Author" });

      const postA = await createPost(prisma, {
        caller: callerSubject(authorA),
        authorChapterId: chapterA.id,
        body: "Chapter A's own restricted content.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });
      const postB = await createPost(prisma, {
        caller: callerSubject(authorB),
        authorChapterId: chapterB.id,
        body: "Chapter B's own restricted content.",
        scopeType: "chapter",
        scopeId: chapterB.id,
      });

      const feedA = await getChapterFeed(prisma, { chapterId: chapterA.id });
      expect(feedA.entries.some((e) => e.sourceId === postA.postId)).toBe(true);
      expect(feedA.entries.some((e) => e.sourceId === postB.postId)).toBe(false); // the negative assertion

      const feedB = await getChapterFeed(prisma, { chapterId: chapterB.id });
      expect(feedB.entries.some((e) => e.sourceId === postB.postId)).toBe(true);
      expect(feedB.entries.some((e) => e.sourceId === postA.postId)).toBe(false);
    });

    it("an org-wide feed query never includes a chapter-scoped post, and vice versa", async () => {
      const admin = await orgAdmin();
      const chapterA = await chapter("Org-vs-Chapter Isolation");
      const member = await person();

      const orgPost = await createPost(prisma, {
        caller: callerSubject(admin),
        authorChapterId: null,
        body: "Org-wide content.",
        scopeType: "org",
        scopeId: null,
      });
      const chapterPost = await createPost(prisma, {
        caller: callerSubject(member),
        authorChapterId: chapterA.id,
        body: "Chapter-only content.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });

      const orgFeed = await getOrgFeed(prisma);
      expect(orgFeed.entries.some((e) => e.sourceId === orgPost.postId)).toBe(true);
      expect(orgFeed.entries.some((e) => e.sourceId === chapterPost.postId)).toBe(false);

      const chapterFeed = await getChapterFeed(prisma, { chapterId: chapterA.id });
      expect(chapterFeed.entries.some((e) => e.sourceId === chapterPost.postId)).toBe(true);
      expect(chapterFeed.entries.some((e) => e.sourceId === orgPost.postId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  describe("getPostSnapshot — stable contract (Phase 6 completion bar)", () => {
    it("returns the documented, stable shape for a real post", async () => {
      const chapterA = await chapter("Snapshot Contract Chapter");
      const author = await person({ displayName: "Snapshot Author" });
      const { postId } = await createPost(prisma, {
        caller: callerSubject(author),
        authorChapterId: chapterA.id,
        body: "A post whose snapshot contract must stay stable.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        attachments: [{ r2ObjectKey: "attachments/posts/x/y.jpg", contentType: "image/jpeg", sizeBytes: 1024 }],
      });

      const snapshot = await getPostSnapshot(prisma, postId);
      expect(snapshot).not.toBeNull();

      // The exact field set a future Moderation-phase `reportedContentSnapshot`
      // depends on — asserted explicitly so a later, unrelated refactor
      // that silently drops/renames a field is caught here, since nothing
      // else exercises this function end-to-end yet.
      expect(Object.keys(snapshot!).sort()).toEqual(
        [
          "postId",
          "authorId",
          "authorDisplayName",
          "authorChapterId",
          "body",
          "scopeType",
          "scopeId",
          "attachments",
          "status",
          "hiddenByModerationActionId",
          "createdAt",
          "updatedAt",
        ].sort(),
      );

      expect(snapshot).toMatchObject({
        postId,
        authorId: author.id,
        authorDisplayName: "Snapshot Author",
        authorChapterId: chapterA.id,
        body: "A post whose snapshot contract must stay stable.",
        scopeType: "chapter",
        scopeId: chapterA.id,
        status: "published",
        hiddenByModerationActionId: null,
      });
      expect(snapshot!.attachments).toEqual([
        { r2ObjectKey: "attachments/posts/x/y.jpg", contentType: "image/jpeg", sizeBytes: 1024 },
      ]);
      expect(typeof snapshot!.createdAt).toBe("string");
      expect(new Date(snapshot!.createdAt).toString()).not.toBe("Invalid Date");
      expect(typeof snapshot!.updatedAt).toBe("string");
    });

    it("returns null for an unknown postId, rather than throwing", async () => {
      const snapshot = await getPostSnapshot(prisma, newId());
      expect(snapshot).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe("Kudos", () => {
    it("rejects self-kudos and a mismatched achievement reference", async () => {
      const p = await person();
      await expect(
        giveKudos(prisma, { caller: callerSubject(p), toPersonId: p.id }),
      ).rejects.toBeInstanceOf(SelfKudosNotAllowedError);

      const other = await person();
      await expect(
        giveKudos(prisma, {
          caller: callerSubject(p),
          toPersonId: other.id,
          achievementRefType: "gamification.badge_award", // no matching achievementRefId
        }),
      ).rejects.toBeInstanceOf(AchievementReferenceMismatchError);
    });

    it("giving kudos persists it, creates a native feed entry, and is queryable via getKudosReceived", async () => {
      const from = await person({ displayName: "Kudos Giver" });
      const to = await person({ displayName: "Kudos Recipient" });

      const { kudosId } = await giveKudos(prisma, {
        caller: callerSubject(from),
        toPersonId: to.id,
        note: "Great work on the event!",
      });
      expect(kudosId).toBeTruthy();

      const received = await getKudosReceived(prisma, { personId: to.id });
      expect(received.some((k) => k.kudosId === kudosId)).toBe(true);
      expect(received.find((k) => k.kudosId === kudosId)?.note).toBe("Great work on the event!");

      const feedEntry = await prisma.feedEntry.findFirst({ where: { sourceId: kudosId, kind: "kudos_given" } });
      expect(feedEntry).not.toBeNull();
      expect(feedEntry?.subjectPersonId).toBe(to.id); // the recipient, not the giver
      expect(feedEntry?.summary).toContain("Kudos Giver");
      expect(feedEntry?.summary).toContain("Kudos Recipient");
    });
  });

  // ---------------------------------------------------------------------
  describe("Teams", () => {
    it("enforces (chapterId, name) uniqueness among active teams (Team invariant 1)", async () => {
      const chapterA = await chapter("Team Uniqueness Chapter");
      const founder = await person();
      await createTeam(prisma, { caller: callerSubject(founder), chapterId: chapterA.id, name: "Trail Crew" });

      await expect(
        createTeam(prisma, { caller: callerSubject(founder), chapterId: chapterA.id, name: "Trail Crew" }),
      ).rejects.toBeInstanceOf(TeamNameTakenError);
    });

    it("creating a team opens the creator's own lead membership", async () => {
      const chapterA = await chapter("Team Lead Chapter");
      const founder = await person();
      const { teamId } = await createTeam(prisma, {
        caller: callerSubject(founder),
        chapterId: chapterA.id,
        name: "Founders Guild",
      });

      const membership = await prisma.teamMembership.findFirst({ where: { teamId, personId: founder.id } });
      expect(membership?.role).toBe("lead");
      expect(membership?.leftAt).toBeNull();
    });

    it("joinTeam rejects a second open membership for the same (team, person) — TeamMembership invariant 2", async () => {
      const chapterA = await chapter("Join Team Chapter");
      const founder = await person();
      const joiner = await person({ displayName: "Team Joiner" });
      const { teamId } = await createTeam(prisma, { caller: callerSubject(founder), chapterId: chapterA.id, name: "Joinable Guild" });

      const joined = await joinTeam(prisma, { caller: callerSubject(joiner), teamId });
      expect(joined.teamMembershipId).toBeTruthy();

      const feedEntry = await prisma.feedEntry.findFirst({
        where: { sourceId: joined.teamMembershipId, kind: "team_joined" },
      });
      expect(feedEntry).not.toBeNull();
      expect(feedEntry?.scopeType).toBe("chapter");
      expect(feedEntry?.scopeId).toBe(chapterA.id);
      expect(feedEntry?.subjectPersonId).toBe(joiner.id);
      expect(feedEntry?.summary).toContain("Team Joiner");
      expect(feedEntry?.summary).toContain("Joinable Guild");

      await expect(joinTeam(prisma, { caller: callerSubject(joiner), teamId })).rejects.toBeInstanceOf(
        AlreadyTeamMemberError,
      );
    });

    it("joinTeam throws TeamNotFoundError for an unknown team", async () => {
      const joiner = await person();
      await expect(joinTeam(prisma, { caller: callerSubject(joiner), teamId: newId() })).rejects.toBeInstanceOf(
        TeamNotFoundError,
      );
    });
  });

  // ---------------------------------------------------------------------
  describe("Mentorship", () => {
    it("rejects self-mentorship and a second open mentee pairing (Mentorship invariants 1 & 2)", async () => {
      const p = await person();
      await expect(
        requestMentorship(prisma, { caller: callerSubject(p), mentorPersonId: p.id }),
      ).rejects.toBeInstanceOf(SelfMentorshipNotAllowedError);

      const mentorA = await person({ displayName: "Mentor A" });
      const mentorB = await person({ displayName: "Mentor B" });
      const mentee = await person({ displayName: "Serial Mentee" });

      await requestMentorship(prisma, { caller: callerSubject(mentee), mentorPersonId: mentorA.id });
      await expect(
        requestMentorship(prisma, { caller: callerSubject(mentee), mentorPersonId: mentorB.id }),
      ).rejects.toBeInstanceOf(AlreadyHasOpenMentorshipError);
    });

    it("the full request -> accept lifecycle: only the mentor may accept, and only once", async () => {
      const mentor = await person({ displayName: "Accepting Mentor" });
      const mentee = await person({ displayName: "Accepted Mentee" });
      const impostor = await person({ displayName: "Not The Mentor" });

      const { mentorshipId } = await requestMentorship(prisma, {
        caller: callerSubject(mentee),
        mentorPersonId: mentor.id,
        note: "Would love your guidance.",
      });

      await expect(
        acceptMentorship(prisma, { caller: callerSubject(impostor), mentorshipId }),
      ).rejects.toBeInstanceOf(NotTheMentorError);

      const accepted = await acceptMentorship(prisma, { caller: callerSubject(mentor), mentorshipId });
      expect(accepted.status).toBe("active");
      expect(new Date(accepted.startedAt).toString()).not.toBe("Invalid Date");

      const row = await prisma.mentorship.findUnique({ where: { id: mentorshipId } });
      expect(row?.status).toBe("active");
      expect(row?.startedAt).not.toBeNull();

      const feedEntry = await prisma.feedEntry.findFirst({
        where: { sourceId: mentorshipId, kind: "mentorship_started" },
      });
      expect(feedEntry).not.toBeNull();
      expect(feedEntry?.scopeType).toBe("org");
      expect(feedEntry?.scopeId).toBeNull();
      expect(feedEntry?.subjectPersonId).toBe(mentee.id);
      expect(feedEntry?.summary).toContain("Accepting Mentor");
      expect(feedEntry?.summary).toContain("Accepted Mentee");

      await expect(
        acceptMentorship(prisma, { caller: callerSubject(mentor), mentorshipId }),
      ).rejects.toBeInstanceOf(MentorshipNotRequestedError);

      const startedEvents = await prisma.communityDomainEvent.findMany({
        where: { eventType: "MentorshipStarted", aggregateId: mentorshipId },
      });
      expect(startedEvents).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  describe("Inbound event consumers — idempotent projection & snapshot invariant (Phase 6 completion bar)", () => {
    it("CORE INVARIANT: earning a badge produces a feed entry within one outbox-drain cycle, and that entry's content is unchanged even after the badge definition is later edited", async () => {
      const earner = await person({ displayName: "Badge Earner" });
      const badgeId = newId();
      badgeIds.push(badgeId);
      await prisma.badge.create({
        data: {
          id: badgeId,
          slug: `community-test-badge-${badgeId.toLowerCase()}`,
          name: "Community Champion",
          criteria: { type: "points_total", threshold: 0 },
          active: true,
          iconUrl: "https://example.test/icons/champion.svg",
        },
      });

      // "Earning a badge" — the real Phase 5 producer, inside its own
      // transaction, exactly as `adminAwardBadge`/badge-criteria evaluation
      // would call it. This is the literal source-of-truth write; nothing
      // in `community` is touched yet.
      const award = await prisma.$transaction((tx) => awardBadge(tx, { personId: earner.id, badgeId }));
      expect(award.awarded).toBe(true);

      const sourceEvent = await prisma.gamificationDomainEvent.findFirstOrThrow({
        where: { eventType: "BadgeAwarded", aggregateId: award.badgeAwardId! },
      });

      // "Within one outbox-drain cycle": a single dispatch of this one
      // unprocessed gamification.domain_events row through this context's
      // consumer entry point — the same shape a future graphile-worker task
      // draining gamification.domain_events would perform per row.
      const inboundEvent: InboundEvent = {
        sourceEventId: sourceEvent.id,
        eventType: sourceEvent.eventType,
        payload: sourceEvent.payload,
      };
      const result = await consumeInboundEvent(prisma, inboundEvent);
      expect(result).toEqual({ processed: true, recognized: true });

      const feedEntry = await prisma.feedEntry.findFirstOrThrow({
        where: { sourceEventId: sourceEvent.id, kind: "badge_awarded" },
      });
      expect(feedEntry.subjectPersonId).toBe(earner.id);
      expect(feedEntry.subjectDisplayName).toBe("Badge Earner");
      expect(feedEntry.sourceType).toBe("gamification.badge_award");
      expect(feedEntry.sourceId).toBe(award.badgeAwardId);
      expect(feedEntry.summary).toBe("Badge Earner earned the Community Champion badge");
      expect(feedEntry.payload).toEqual({ badgeName: "Community Champion", badgeIconKey: "https://example.test/icons/champion.svg" });

      const summaryBeforeEdit = feedEntry.summary;
      const payloadBeforeEdit = feedEntry.payload;

      // Now edit the underlying badge DEFINITION — same shape as Phase 5's
      // own "badge remains visible after deactivation" test, but proving
      // the opposite direction here: the feed projection must NOT reflect
      // this edit at all, because it is a snapshot, not a live join.
      await prisma.badge.update({
        where: { id: badgeId },
        data: { name: "Renamed After The Fact", iconUrl: "https://example.test/icons/renamed.svg", active: false },
      });

      const feedEntryAfterEdit = await prisma.feedEntry.findUniqueOrThrow({ where: { id: feedEntry.id } });
      expect(feedEntryAfterEdit.summary).toBe(summaryBeforeEdit);
      expect(feedEntryAfterEdit.payload).toEqual(payloadBeforeEdit);
      expect(feedEntryAfterEdit.summary).not.toContain("Renamed After The Fact");

      // And redelivering the exact same source event a second time is a
      // no-op — no duplicate feed row, matching FeedEntry invariant 3 /
      // ADR-0009's idempotent-consumer guarantee.
      const redelivered = await consumeInboundEvent(prisma, inboundEvent);
      expect(redelivered).toEqual({ processed: false, recognized: true });
      const feedEntriesForEvent = await prisma.feedEntry.findMany({ where: { sourceEventId: sourceEvent.id } });
      expect(feedEntriesForEvent).toHaveLength(1);

      const processedEventRow = await prisma.communityProcessedEvent.findUnique({ where: { id: sourceEvent.id } });
      expect(processedEventRow?.sourceContext).toBe("gamification");
      expect(processedEventRow?.eventType).toBe("BadgeAwarded");
    });

    it("an unrecognized event type is a no-op, not an error", async () => {
      const result = await consumeInboundEvent(prisma, {
        sourceEventId: newId(),
        eventType: "SomethingThisConsumerDoesNotSubscribeTo",
        payload: {},
      });
      expect(result).toEqual({ processed: false, recognized: false });
    });

    it("HandleHoursApproved projects an immutable hours_approved snapshot, scoped from the event payload's own chapterId", async () => {
      const earner = await person({ displayName: "Hours Earner" });
      const chapterA = await chapter("Hours Approved Chapter");
      const opportunity = await createOpportunityDirect(prisma, { title: "Trail Cleanup Day", chapterId: chapterA.id });
      opportunityIds.push(opportunity.id);

      const event: InboundEvent = {
        sourceEventId: newId(),
        eventType: "HoursApproved",
        payload: {
          hourEntryId: newId(),
          personId: earner.id,
          opportunityId: opportunity.id,
          shiftId: null,
          chapterId: chapterA.id,
          durationMinutes: 90,
          approverPersonId: newId(),
          approvedAt: new Date().toISOString(),
        },
      };

      const result = await consumeInboundEvent(prisma, event);
      expect(result).toEqual({ processed: true, recognized: true });

      const feedEntry = await prisma.feedEntry.findFirstOrThrow({ where: { sourceEventId: event.sourceEventId } });
      expect(feedEntry.kind).toBe("hours_approved");
      expect(feedEntry.scopeType).toBe("chapter");
      expect(feedEntry.scopeId).toBe(chapterA.id);
      expect(feedEntry.summary).toContain("Hours Earner");
      expect(feedEntry.summary).toContain("Trail Cleanup Day");
      expect(feedEntry.payload).toMatchObject({ hours: 1.5, opportunityTitle: "Trail Cleanup Day" });

      // And it shows up in that chapter's feed, scoped correctly.
      const feed = await getChapterFeed(prisma, { chapterId: chapterA.id });
      expect(feed.entries.some((e) => e.feedEntryId === feedEntry.id)).toBe(true);
    });

    it("HandleHoursApproved throws SourceRecordNotFoundError for an unresolvable opportunityId", async () => {
      const earner = await person();
      await expect(
        consumeInboundEvent(prisma, {
          sourceEventId: newId(),
          eventType: "HoursApproved",
          payload: {
            hourEntryId: newId(),
            personId: earner.id,
            opportunityId: newId(), // no such opportunity
            shiftId: null,
            chapterId: null,
            durationMinutes: 60,
            approverPersonId: newId(),
            approvedAt: new Date().toISOString(),
          },
        }),
      ).rejects.toBeInstanceOf(SourceRecordNotFoundError);
    });

    it("HandleCourseCompleted projects an org-wide course_completed snapshot", async () => {
      const graduate = await person({ displayName: "Course Graduate" });
      const course = await createCourseDirect(prisma, { title: "Volunteer Safety 101" });
      courseIds.push(course.id);

      const event: InboundEvent = {
        sourceEventId: newId(),
        eventType: "CourseCompleted",
        payload: {
          enrollmentId: newId(),
          personId: graduate.id,
          courseId: course.id,
          completedAt: new Date().toISOString(),
        },
      };

      await consumeInboundEvent(prisma, event);

      const feedEntry = await prisma.feedEntry.findFirstOrThrow({ where: { sourceEventId: event.sourceEventId } });
      expect(feedEntry.kind).toBe("course_completed");
      expect(feedEntry.scopeType).toBe("org");
      expect(feedEntry.scopeId).toBeNull();
      expect(feedEntry.summary).toBe("Course Graduate completed Volunteer Safety 101");
      expect(feedEntry.payload).toEqual({ courseTitle: "Volunteer Safety 101" });
    });

    it("HandleStreakExtended is filtered to milestone lengths — a non-milestone day is acknowledged but produces no feed row", async () => {
      const p = await person();

      const nonMilestone: InboundEvent = {
        sourceEventId: newId(),
        eventType: "StreakExtended",
        payload: { personId: p.id, activityType: "shift_cadence", currentLength: 3 },
      };
      const nonMilestoneResult = await consumeInboundEvent(prisma, nonMilestone);
      expect(nonMilestoneResult).toEqual({ processed: true, recognized: true }); // acknowledged (processed_events written)...
      const noFeedEntry = await prisma.feedEntry.findFirst({ where: { sourceEventId: nonMilestone.sourceEventId } });
      expect(noFeedEntry).toBeNull(); // ...but no feed row (day 3 isn't a milestone)

      const processedRow = await prisma.communityProcessedEvent.findUnique({ where: { id: nonMilestone.sourceEventId } });
      expect(processedRow).not.toBeNull(); // never reprocessed on redelivery either

      const milestone: InboundEvent = {
        sourceEventId: newId(),
        eventType: "StreakExtended",
        payload: { personId: p.id, activityType: "shift_cadence", currentLength: 7 },
      };
      await consumeInboundEvent(prisma, milestone);
      const feedEntry = await prisma.feedEntry.findFirstOrThrow({ where: { sourceEventId: milestone.sourceEventId } });
      expect(feedEntry.kind).toBe("streak_extended");
      expect(feedEntry.summary).toContain("7-day streak");
    });
  });

  // ---------------------------------------------------------------------
  describe("searchPosts (ADR-0017 full-text search)", () => {
    it("finds a matching post within its own scope, and never leaks across a chapter boundary", async () => {
      const chapterA = await chapter("Search Chapter A");
      const chapterB = await chapter("Search Chapter B");
      const authorA = await person();
      const authorB = await person();

      const postA = await createPost(prisma, {
        caller: callerSubject(authorA),
        authorChapterId: chapterA.id,
        body: "We need volunteers for the xylophonic river cleanup this weekend.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });
      await createPost(prisma, {
        caller: callerSubject(authorB),
        authorChapterId: chapterB.id,
        body: "Xylophonic river cleanup planning notes for chapter B.",
        scopeType: "chapter",
        scopeId: chapterB.id,
      });

      const resultsInA = await searchPosts(prisma, { query: "xylophonic", scopeType: "chapter", scopeId: chapterA.id });
      expect(resultsInA.map((r) => r.postId)).toEqual([postA.postId]);

      const resultsInB = await searchPosts(prisma, { query: "xylophonic", scopeType: "chapter", scopeId: chapterB.id });
      expect(resultsInB.some((r) => r.postId === postA.postId)).toBe(false);
    });

    it("excludes a hidden post from results", async () => {
      const chapterA = await chapter("Search Hidden Chapter");
      const author = await person();
      const { postId } = await createPost(prisma, {
        caller: callerSubject(author),
        authorChapterId: chapterA.id,
        body: "Findable until hidden: platypusword search marker.",
        scopeType: "chapter",
        scopeId: chapterA.id,
      });

      const before = await searchPosts(prisma, { query: "platypusword", scopeType: "chapter", scopeId: chapterA.id });
      expect(before.some((r) => r.postId === postId)).toBe(true);

      await prisma.post.update({ where: { id: postId }, data: { status: "hidden" } });

      const after = await searchPosts(prisma, { query: "platypusword", scopeType: "chapter", scopeId: chapterA.id });
      expect(after.some((r) => r.postId === postId)).toBe(false);
    });
  });
});
