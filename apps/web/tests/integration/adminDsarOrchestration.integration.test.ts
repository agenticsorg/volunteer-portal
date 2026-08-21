import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { orchestrateDsarRequest, consumeIdentityDsarEvents, getExportJob, ForbiddenActionError } from "@/modules/admin";
import { createPerson, grantRoleDirect } from "./helpers/identityFixtures";
import { callerSubject } from "./helpers/volunteeringFixtures";

// Exercises `OrchestrateDsarRequest`/`consumeIdentityDsarEvents`
// (docs/ddd/admin-reporting.md, Key Use Case 4) end to end against a real
// Postgres — Phase 9's "Do not consider this phase complete until" bar's
// second bullet: "a DSAR erasure triggered from the admin console
// anonymizes the target Person via identity's own machinery (not a direct
// write from this module) and the ExportJob correctly reflects completion."
//
// CRITICAL invariant under test here (restated from
// `orchestrateDsarRequest.ts`'s own header): this call path NEVER reads or
// writes `identity.persons`/`identity.dsar_requests` directly — it only
// ever calls `identity.submitDsarRequest(...)` (a command, through
// `identity`'s own `index.ts` barrel) and later reacts to `identity`'s own
// published `DsarExportCompleted`/`DsarEraseCompleted` domain events. This
// suite proves that end-to-end behaviorally: the Person is anonymized (by
// `identity`'s own synchronous `requestErasure`, confirmed via
// `dsar.integration.test.ts`) before admin's own `ExportJob` even learns
// the outcome — admin's row sits at `queued` until this test itself reads
// the real `identity.domain_events` row and hands it to
// `consumeIdentityDsarEvents`, exactly the shape a real drain-worker would
// perform, without this module ever issuing its own query against any
// `identity.*` table.
describe("Admin DSAR orchestration — OrchestrateDsarRequest / consumeIdentityDsarEvents (integration)", () => {
  const prisma = new PrismaClient();
  const personIds: string[] = [];
  const exportJobIds: string[] = [];
  const processedEventIds: string[] = [];

  afterAll(async () => {
    await prisma.adminProcessedEvent.deleteMany({ where: { id: { in: processedEventIds } } });
    await prisma.adminDomainEvent.deleteMany({ where: { aggregateId: { in: exportJobIds } } });
    await prisma.exportJob.deleteMany({ where: { id: { in: exportJobIds } } });
    await prisma.identityDomainEvent.deleteMany({ where: { aggregateId: { in: personIds } } });
    await prisma.dSARRequest.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.roleAssignment.deleteMany({ where: { subjectId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.$disconnect();
  });

  async function orgAdmin() {
    const p = await createPerson(prisma, { displayName: "DSAR Orchestrating Admin" });
    personIds.push(p.id);
    await grantRoleDirect(prisma, { subjectId: p.id, role: "org_admin", grantedBy: p.id });
    return p;
  }

  async function subject(displayName: string) {
    const p = await createPerson(prisma, { displayName });
    personIds.push(p.id);
    return p;
  }

  /**
   * Reads back the exact `identity.domain_events` row
   * `consumeIdentityDsarEvents` is meant to drain — the ONLY thing this
   * test suite ever reads from `identity`'s own tables (a raw event row,
   * same separation `consumeIdentityDsarEvents.ts`'s own doc comment
   * draws between "a caller reads the event" and "this function itself
   * never queries `identity.*`").
   */
  async function findDsarCompletionEvent(dsarId: string, eventType: "DsarExportCompleted" | "DsarEraseCompleted") {
    return prisma.identityDomainEvent.findFirstOrThrow({
      where: { aggregateType: "DSARRequest", aggregateId: dsarId, eventType },
    });
  }

  describe("operation: 'erase'", () => {
    it("anonymizes the target Person via identity's own machinery, and the correlated ExportJob reflects completion once the completion event is drained", async () => {
      const org = await orgAdmin();
      const target = await subject("Erase Me Via Admin Console");

      const orchestrated = await orchestrateDsarRequest(prisma, {
        caller: callerSubject(org),
        subjectId: target.id,
        operation: "erase",
      });
      exportJobIds.push(orchestrated.exportJobId);

      // identity's own machinery (`requestErasure`, called synchronously
      // in-process by `submitDsarRequest` — see that file's own doc
      // comment) has ALREADY anonymized the Person by the time this call
      // returns. `admin` never touched `identity.persons` itself.
      const anonymized = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
      expect(anonymized.status).toBe("anonymized");
      expect(anonymized.displayName).toBe("Deleted User");
      expect(anonymized.email).toBe(`anonymized+${target.id.toLowerCase()}@volunteer-portal.invalid`);

      // But the correlated ExportJob is still only `queued` — admin only
      // learns the outcome asynchronously, via the completion event.
      const queuedJob = await getExportJob(prisma, { caller: callerSubject(org), id: orchestrated.exportJobId });
      expect(queuedJob.status).toBe("queued");
      expect(queuedJob.type).toBe("dsar_export");
      expect(queuedJob.identityDsarRequestId).toBe(orchestrated.identityDsarRequestId);

      const event = await findDsarCompletionEvent(orchestrated.identityDsarRequestId, "DsarEraseCompleted");
      const result = await consumeIdentityDsarEvents(prisma, {
        sourceEventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });
      processedEventIds.push(event.id);
      expect(result).toEqual({ processed: true, recognized: true });

      const completedJob = await getExportJob(prisma, { caller: callerSubject(org), id: orchestrated.exportJobId });
      expect(completedJob.status).toBe("completed");
      expect(completedJob.completedAt).not.toBeNull();
      // "completion is a status change, not an artifact" — Schema Sketch.
      expect(completedJob.outputFileKey).toBeNull();
      expect(completedJob.outputFileFormat).toBeNull();

      // Redelivery of the same source event is a strict no-op — the
      // idempotency ledger (`admin.processed_events`) rejects it, and the
      // already-terminal ExportJob is never touched a second time.
      const redelivered = await consumeIdentityDsarEvents(prisma, {
        sourceEventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });
      expect(redelivered).toEqual({ processed: false, recognized: true });
    });
  });

  describe("operation: 'export'", () => {
    it("does not anonymize the subject, and the correlated ExportJob picks up identity's own signed export URL once the completion event is drained", async () => {
      const org = await orgAdmin();
      const target = await subject("Export Me Via Admin Console");

      const orchestrated = await orchestrateDsarRequest(prisma, {
        caller: callerSubject(org),
        subjectId: target.id,
        operation: "export",
      });
      exportJobIds.push(orchestrated.exportJobId);

      const stillActive = await prisma.person.findUniqueOrThrow({ where: { id: target.id } });
      expect(stillActive.status).toBe("active");
      expect(stillActive.displayName).toBe("Export Me Via Admin Console");

      const event = await findDsarCompletionEvent(orchestrated.identityDsarRequestId, "DsarExportCompleted");
      const result = await consumeIdentityDsarEvents(prisma, {
        sourceEventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });
      processedEventIds.push(event.id);
      expect(result).toEqual({ processed: true, recognized: true });

      const completedJob = await getExportJob(prisma, { caller: callerSubject(org), id: orchestrated.exportJobId });
      expect(completedJob.status).toBe("completed");
      expect(completedJob.outputFileFormat).toBe("zip");
      expect(completedJob.outputFileKey).toBeTruthy();
      expect(completedJob.outputFileExpiresAt).not.toBeNull();
    });
  });

  it("rejects OrchestrateDsarRequest from a caller who is not an org_admin", async () => {
    const nonAdmin = await subject("Not An Admin");
    const target = await subject("Some Subject");
    await expect(
      orchestrateDsarRequest(prisma, { caller: callerSubject(nonAdmin), subjectId: target.id, operation: "export" }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });

  it("consumeIdentityDsarEvents ignores an unrecognized event type without touching any ExportJob or throwing", async () => {
    const result = await consumeIdentityDsarEvents(prisma, {
      sourceEventId: "not-a-real-event-id-unrecognized-type",
      eventType: "SomeUnrelatedEvent",
      payload: {},
    });
    expect(result).toEqual({ processed: false, recognized: false });
  });
});
