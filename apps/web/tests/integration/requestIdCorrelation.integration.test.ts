import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { communityRouter } from "@/server/api/routers/community";
import { createCallerFactory } from "@/server/api/trpc";
import { createPerson, createChapterDirect, contextFor } from "./helpers/identityFixtures";

// ADR-0013 §"Correlation": "every inbound request gets a `requestId` ...
// every domain event ... carries the originating `requestId` through the
// outbox". This is the real, end-to-end proof this stage's task asks for:
// a tRPC call ("a request") that creates a domain event, then reading that
// event's stored row back out of real Postgres and confirming its payload
// carries the exact requestId that request's Context carried — through
// `withRequestContext` (server/api/trpc.ts) → `runWithRequestContext`
// (AsyncLocalStorage) → `publishCommunityEvent` → `attachRequestMetadata`,
// with no explicit `requestId` parameter threaded through `createPost`'s
// own application-layer signature anywhere in that chain.
describe("requestId correlation (integration)", () => {
  const prisma = new PrismaClient();
  const createCaller = createCallerFactory(communityRouter);
  const personIds: string[] = [];
  const chapterIds: string[] = [];

  afterAll(async () => {
    const postIds = await prisma.post
      .findMany({ where: { authorId: { in: personIds } }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    await prisma.communityDomainEvent.deleteMany({ where: { aggregateId: { in: postIds } } });
    await prisma.post.deleteMany({ where: { authorId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.chapter.deleteMany({ where: { id: { in: chapterIds } } });
  });

  it("stamps the request's requestId onto the domain event the request's mutation publishes", async () => {
    const chapter = await createChapterDirect(prisma, { name: "Correlation Test Chapter" });
    chapterIds.push(chapter.id);
    const author = await createPerson(prisma, { displayName: "Correlation Author" });
    personIds.push(author.id);
    await prisma.person.update({ where: { id: author.id }, data: { primaryChapterId: chapter.id } });

    const knownRequestId = "test-request-id-correlation-12345";
    const ctx = { ...contextFor(prisma, { ...author, primaryChapterId: chapter.id }), requestId: knownRequestId };
    const caller = createCaller(ctx);

    const created = await caller.createPost({
      body: "Does this event carry the request's id?",
      scopeType: "chapter",
      scopeId: chapter.id,
      attachments: [],
    });

    const event = await prisma.communityDomainEvent.findFirst({
      where: { eventType: "PostCreated", aggregateId: created.postId },
    });

    expect(event).not.toBeNull();
    const payload = event!.payload as Record<string, unknown>;
    expect(payload._meta).toEqual({ requestId: knownRequestId });
  });

  it("two different requests' events carry two different requestIds", async () => {
    const chapter = await createChapterDirect(prisma, { name: "Correlation Test Chapter 2" });
    chapterIds.push(chapter.id);
    const author = await createPerson(prisma, { displayName: "Correlation Author 2" });
    personIds.push(author.id);
    await prisma.person.update({ where: { id: author.id }, data: { primaryChapterId: chapter.id } });

    const personShape = { ...author, primaryChapterId: chapter.id };

    const first = await createCaller({ ...contextFor(prisma, personShape), requestId: "req-first" }).createPost({
      body: "First request.",
      scopeType: "chapter",
      scopeId: chapter.id,
      attachments: [],
    });
    const second = await createCaller({ ...contextFor(prisma, personShape), requestId: "req-second" }).createPost({
      body: "Second request.",
      scopeType: "chapter",
      scopeId: chapter.id,
      attachments: [],
    });

    const [firstEvent, secondEvent] = await Promise.all([
      prisma.communityDomainEvent.findFirst({ where: { eventType: "PostCreated", aggregateId: first.postId } }),
      prisma.communityDomainEvent.findFirst({ where: { eventType: "PostCreated", aggregateId: second.postId } }),
    ]);

    expect((firstEvent!.payload as Record<string, unknown>)._meta).toEqual({ requestId: "req-first" });
    expect((secondEvent!.payload as Record<string, unknown>)._meta).toEqual({ requestId: "req-second" });
  });
});
