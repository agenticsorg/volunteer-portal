import { Prisma, type PrismaClient } from "@prisma/client";
import { newId } from "@volunteer-portal/ulid";
import { recordAuditEvent } from "@volunteer-portal/audit";
import type { VerifiedSupabaseSession } from "@/server/auth/verified-session";
import {
  AgeGateError,
  IncompleteGuardianConsentError,
  PersonAlreadyRegisteredError,
} from "../domain/errors";

/**
 * RegisterPerson — the anti-corruption translation from a verified
 * Supabase session into this bounded context's own `Person` aggregate
 * (docs/ddd/identity-access-schema-api.md's `identity.register` contract;
 * ADR-0006's "Integration & Anti-Corruption Notes": "`RegisterPerson`
 * translates a verified Supabase JWT (`supabaseAuthId`, `email`) into this
 * context's own `Person` model").
 *
 * `input.session` is the *only* Supabase-shaped data this function
 * touches, and it's already been narrowed to two plain strings by
 * `server/auth/verified-session.ts` before it ever reaches here — this
 * file has no `@supabase/supabase-js` import and never will. Every other
 * input field is form data this bounded context already owns the shape
 * of (the contract sketch's `register` mutation input, minus the two
 * fields the caller must not be trusted to supply themselves: the caller
 * cannot pick their own `supabaseAuthId`/`email` — those come from
 * `ctx.supabaseSession`, resolved server-side from the verified cookie,
 * never from client-submitted input. See `server/api/routers/identity.ts`.
 */

export interface GuardianConsentInput {
  guardianName: string;
  guardianEmail: string;
}

export interface RegisterPersonInput {
  session: VerifiedSupabaseSession;
  displayName: string;
  primaryChapterId: string | null;
  /** ISO date (`YYYY-MM-DD`), or `null` if relying on `ageAttested16Plus`. */
  dateOfBirth: string | null;
  ageAttested16Plus: boolean;
  guardianConsent: GuardianConsentInput | null;
  policyVersion: string;
}

export interface RegisteredPerson {
  personId: string;
  publicSlug: string;
}

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * A public, URL-safe handle distinct from the person's real name/email
 * (`persons.public_slug`, unique). Not a security boundary — collisions on
 * the human-readable prefix are expected and resolved by the ULID-derived
 * suffix, not guessed against.
 */
function derivePublicSlug(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = newId().slice(-8).toLowerCase();
  return base ? `${base}-${suffix}` : suffix;
}

export async function registerPerson(
  prisma: PrismaClient,
  input: RegisterPersonInput,
): Promise<RegisteredPerson> {
  if (!input.dateOfBirth && !input.ageAttested16Plus) {
    throw new AgeGateError();
  }
  if (
    input.guardianConsent &&
    (!input.guardianConsent.guardianName || !input.guardianConsent.guardianEmail)
  ) {
    throw new IncompleteGuardianConsentError();
  }

  const personId = newId();
  const publicSlug = derivePublicSlug(input.displayName);

  try {
    const person = await prisma.$transaction(async (tx) => {
      const created = await tx.person.create({
        data: {
          id: personId,
          publicSlug,
          supabaseAuthId: input.session.supabaseAuthId,
          email: input.session.email,
          displayName: input.displayName,
          primaryChapterId: input.primaryChapterId,
          dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
          ageAttested16Plus: input.ageAttested16Plus,
        },
        select: { id: true, publicSlug: true, email: true, displayName: true, createdAt: true },
      });

      await tx.consentRecord.create({
        data: {
          id: newId(),
          personId: created.id,
          purpose: "terms_of_service",
          granted: true,
          policyVersion: input.policyVersion,
          source: "signup_form",
        },
      });

      if (input.guardianConsent) {
        await tx.consentRecord.create({
          data: {
            id: newId(),
            personId: created.id,
            purpose: "guardian_consent",
            granted: true,
            policyVersion: input.policyVersion,
            source: "guardian_form",
            guardianName: input.guardianConsent.guardianName,
            guardianEmail: input.guardianConsent.guardianEmail,
          },
        });
      }

      // PersonRegistered payload, field-for-field per
      // docs/ddd/identity-access.md's Domain Events table.
      await tx.identityDomainEvent.create({
        data: {
          id: newId(),
          aggregateType: "Person",
          aggregateId: created.id,
          eventType: "PersonRegistered",
          payload: {
            personId: created.id,
            publicSlug: created.publicSlug,
            email: created.email,
            displayName: created.displayName,
            primaryChapterId: input.primaryChapterId,
            ageAttested16Plus: input.ageAttested16Plus,
            registeredAt: created.createdAt.toISOString(),
          } satisfies Prisma.InputJsonValue,
        },
      });

      // Key Use Case 1 (RegisterPerson) Post: "`recordAuditEvent()` tags
      // the same outbox write `audit: true` (`action = 'person.register'`),
      // drained into `admin.audit_log` by `audit_log_writer`" — every one
      // of this bounded context's 9 key use cases tags its action this
      // way (ADR-0014 §4's single audit mechanism), including this one.
      await recordAuditEvent(tx.identityDomainEvent, {
        actorId: created.id,
        actorType: "user",
        action: "person.register",
        resourceType: "person",
        resourceId: created.id,
        metadata: { primaryChapterId: input.primaryChapterId },
      });

      return created;
    });

    return { personId: person.id, publicSlug: person.publicSlug };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const target = error.meta?.target;
      const onSupabaseAuthId =
        Array.isArray(target) && target.some((column) => column === "supabase_auth_id");
      if (onSupabaseAuthId) {
        throw new PersonAlreadyRegisteredError(input.session.supabaseAuthId);
      }
    }
    throw error;
  }
}
