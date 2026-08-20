# Identity & Access — Schema & API Contract

Continuation of [identity-access.md](identity-access.md) (Purpose, Ubiquitous Language, Aggregates, Domain Events, and Key Use Cases live there). Split out purely to stay under the repo's 500-line-per-file guideline — this is the same bounded context, same schema `identity`.

## Schema Sketch

```sql
CREATE SCHEMA IF NOT EXISTS identity;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE identity.role_name AS ENUM (
  'volunteer', 'mentor', 'chapter_lead', 'content_admin', 'org_admin', 'moderator'
);

CREATE TYPE identity.scope_type AS ENUM ('global', 'chapter', 'team');

CREATE TYPE identity.consent_purpose AS ENUM (
  'terms_of_service', 'newsletter', 'photo_publication',
  'leaderboard_participation', 'analytics_cookies', 'guardian_consent'
);

CREATE TYPE identity.dsar_type AS ENUM ('export', 'erasure');
CREATE TYPE identity.dsar_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- Chapters created before Persons to avoid a circular FK; the reverse pointer
-- (Chapter.lead_person_id) is intentionally a soft reference, see below.
CREATE TABLE identity.chapters (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  city            text NOT NULL,
  region          text,
  country         text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  founded_at      date,
  lead_person_id  text, -- soft reference to persons.id; no FK, validated at app layer
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chapters_status ON identity.chapters (status);

CREATE TABLE identity.persons (
  id                    text PRIMARY KEY,
  public_slug           text NOT NULL UNIQUE,
  supabase_auth_id      text NOT NULL UNIQUE,
  email                 citext NOT NULL UNIQUE,
  display_name          text NOT NULL,
  pronouns              text,
  avatar_url            text,
  bio                   text,
  date_of_birth         date,
  age_attested_16_plus  boolean NOT NULL DEFAULT false,
  primary_chapter_id    text REFERENCES identity.chapters (id),
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'deactivated', 'anonymized')),
  anonymized_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_persons_age_gate CHECK (
    status = 'anonymized'
    OR date_of_birth IS NOT NULL
    OR age_attested_16_plus = true
  ),
  CONSTRAINT chk_persons_anonymized_at CHECK (
    (status = 'anonymized' AND anonymized_at IS NOT NULL)
    OR (status <> 'anonymized' AND anonymized_at IS NULL)
  )
);
CREATE INDEX idx_persons_chapter ON identity.persons (primary_chapter_id);
CREATE INDEX idx_persons_status ON identity.persons (status);

CREATE TABLE identity.role_assignments (
  id           text PRIMARY KEY,
  subject_id   text NOT NULL REFERENCES identity.persons (id),
  role         identity.role_name NOT NULL,
  scope_type   identity.scope_type NOT NULL DEFAULT 'global',
  scope_id     text, -- chapters.id or a community.teams id (plain, no cross-schema FK)
  granted_by   text NOT NULL REFERENCES identity.persons (id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_by   text REFERENCES identity.persons (id),
  revoked_at   timestamptz,
  CONSTRAINT chk_role_assignments_scope CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR (scope_type IN ('chapter', 'team') AND scope_id IS NOT NULL)
  ),
  CONSTRAINT chk_role_assignments_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);
-- Exactly one active assignment per (subject, role, scope) tuple:
CREATE UNIQUE INDEX uq_role_assignments_active
  ON identity.role_assignments (subject_id, role, scope_type, scope_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_role_assignments_subject_active
  ON identity.role_assignments (subject_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.consent_records (
  id              text PRIMARY KEY,
  person_id       text NOT NULL REFERENCES identity.persons (id),
  purpose         identity.consent_purpose NOT NULL,
  granted         boolean NOT NULL,
  policy_version  text NOT NULL,
  source          text NOT NULL
                    CHECK (source IN ('signup_form', 'settings_page', 'guardian_form', 'admin_override')),
  guardian_name   text,
  guardian_email  citext,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CONSTRAINT chk_consent_guardian_fields CHECK (
    purpose <> 'guardian_consent'
    OR (guardian_name IS NOT NULL AND guardian_email IS NOT NULL)
  )
);
CREATE INDEX idx_consent_records_person_purpose
  ON identity.consent_records (person_id, purpose, recorded_at DESC);

CREATE TABLE identity.dsar_requests (
  id               text PRIMARY KEY,
  person_id        text NOT NULL REFERENCES identity.persons (id),
  type             identity.dsar_type NOT NULL,
  status           identity.dsar_status NOT NULL DEFAULT 'pending',
  requested_by     text NOT NULL REFERENCES identity.persons (id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  export_file_url  text,
  failure_reason   text
);
CREATE INDEX idx_dsar_requests_person ON identity.dsar_requests (person_id);
-- Enforce "at most one open request per (person, type)" at the app layer;
-- this partial index makes the open-request lookup cheap:
CREATE INDEX idx_dsar_requests_open
  ON identity.dsar_requests (person_id, type)
  WHERE status IN ('pending', 'processing');

-- No identity.audit_log table: per ADR-0014, there is exactly one audit table
-- (admin.audit_log). Privileged actions here are recorded via the shared
-- recordAuditEvent() helper, which writes an 'audit.recorded' row (payload
-- tagged audit: true) into identity.domain_events below — the audit_log_writer
-- consumer drains it into admin.audit_log like every other schema's outbox.

CREATE TABLE identity.domain_events (
  id              text PRIMARY KEY, -- ULID; chronological by construction
  aggregate_type  text NOT NULL,    -- 'Person' | 'Chapter' | 'RoleAssignment' | 'ConsentRecord' | 'DSARRequest'
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,    -- 'PersonRegistered' | 'RoleGranted' | ...
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0
);
CREATE INDEX idx_identity_domain_events_unprocessed
  ON identity.domain_events (id) WHERE processed_at IS NULL;
```

## API Contract Sketch

tRPC router `identity`, mounted as this context's public `index.ts` interface
(per ADR-0001, the only surface other modules or the Next.js app may import).

```typescript
export const identityRouter = router({
  // --- Person ---
  register: procedure
    .input(z.object({
      supabaseAuthId: z.string(),
      email: z.string().email(),
      displayName: z.string().min(1).max(120),
      primaryChapterId: ulidSchema.nullable(),
      dateOfBirth: z.string().date().nullable(),
      ageAttested16Plus: z.boolean().default(false),
      guardianConsent: z.object({
        guardianName: z.string(), guardianEmail: z.string().email(),
      }).nullable(),
      policyVersion: z.string(),
    }))
    .mutation(/* -> { personId: string, publicSlug: string } */),

  getPersonSummary: procedure // Open Host Service — the sanctioned cross-context read
    .input(z.object({ personId: ulidSchema }))
    .query(/* -> { personId, publicSlug, displayName, avatarUrl } | null */),

  me: procedure
    .query(/* -> full Person profile for the authenticated caller */),

  // --- Chapters ---
  chapters: router({
    create: procedure
      .input(z.object({ name: z.string(), slug: z.string(), city: z.string(), country: z.string() }))
      .mutation(/* requires can(caller, 'chapter.create') -> { chapterId: string } */),
    assignLead: procedure
      .input(z.object({ chapterId: ulidSchema, personId: ulidSchema }))
      .mutation(/* -> void */),
    list: procedure
      .input(z.object({ status: z.enum(['active', 'inactive']).optional() }))
      .query(/* -> Chapter[] */),
  }),

  // --- Roles ---
  roles: router({
    grant: procedure
      .input(z.object({
        subjectId: ulidSchema, role: roleNameSchema,
        scopeType: z.enum(['global', 'chapter', 'team']),
        scopeId: ulidSchema.nullable(),
      }))
      .mutation(/* requires can(caller, 'role.grant', {role, scopeType, scopeId}) -> { roleAssignmentId } */),
    revoke: procedure
      .input(z.object({ roleAssignmentId: ulidSchema }))
      .mutation(/* -> void */),
    listForSubject: procedure
      .input(z.object({ subjectId: ulidSchema }))
      .query(/* -> RoleAssignment[] (active only, by default) */),
  }),

  // --- Consent ---
  consent: router({
    record: procedure
      .input(z.object({
        personId: ulidSchema, purpose: consentPurposeSchema, granted: z.boolean(),
        policyVersion: z.string(), source: consentSourceSchema,
        guardianName: z.string().optional(), guardianEmail: z.string().email().optional(),
      }))
      .mutation(/* -> { consentId: string } */),
    revoke: procedure
      .input(z.object({ personId: ulidSchema, purpose: consentPurposeSchema }))
      .mutation(/* -> void */),
    getForPerson: procedure
      .input(z.object({ personId: ulidSchema }))
      .query(/* -> ConsentRecord[] (current state per purpose) */),
  }),

  // --- DSAR ---
  dsar: router({
    requestExport: procedure
      .input(z.object({ personId: ulidSchema }))
      .mutation(/* -> { dsarId: string } */),
    requestErasure: procedure
      .input(z.object({ personId: ulidSchema, requestedBy: ulidSchema }))
      .mutation(/* requires can(caller, 'dsar.erasure.request') -> { dsarId: string } */),
    getStatus: procedure
      .input(z.object({ dsarId: ulidSchema }))
      .query(/* -> DSARRequest */),
  }),
});
```

Also exposed under versioned public REST for external/admin tooling that cannot use
tRPC: `GET /api/v1/persons/:id/dsar-export` (signed URL redirect once `completed`),
`POST /api/v1/dsar/erasure-requests` (org-admin only, API-key authenticated).

## Integration & Anti-Corruption Notes

- **Supabase Auth is behind an anti-corruption layer.** `identity.persons` does not
  reuse Supabase's user schema or claims shape directly — `RegisterPerson`
  translates a verified Supabase JWT (`supabaseAuthId`, `email`) into this
  context's own `Person` model. If the auth provider is ever swapped, only this
  translation boundary changes; no other context (which only ever sees
  `getPersonSummary` results or event payloads) is affected.
- **No other context may query `identity.*` tables directly** (ADR-0001 boundary
  rule). Every cross-context read goes through `getPersonSummary` (or an
  equivalent published query) via this module's `index.ts`; every cross-context
  effect goes through a domain event. In particular, `gamification`,
  `community`, and `admin` must **not** join on `identity.persons` — they hold
  their own denormalized `personId → displayName/avatarUrl` projection, kept
  current by consuming `PersonRegistered` and (for the anonymized-display case)
  `PersonAnonymized`.
- **Authorization is centralized but not owned by any one context.** The shared
  `can(subject, action, resource)` policy module (referenced across the codebase,
  ADR-0007) reads `identity.role_assignments` as its source of truth but is
  invoked from every context at its own write boundaries — `identity` publishes
  the facts (`RoleGranted`/`RoleRevoked`), it does not gatekeep other contexts'
  mutations itself.
- **`PersonAnonymized` is a fan-out, not a cascade.** Each downstream context is
  responsible for its own anonymization logic against its own schema (e.g.,
  `volunteering.hour_entries` keeps the row and its `duration_minutes` for grant
  totals but this context's `getPersonSummary` will thereafter return the
  anonymized placeholder name for that `personId`). `identity` does not, and
  structurally cannot (no cross-schema FK), delete rows in other schemas.
- **Guardian consent is itself an ACL from the external world**: a
  guardian typically has no Person account of their own — `guardianName`/
  `guardianEmail` on `ConsentRecord` are captured as plain attributes, not a
  foreign key to another `Person`, precisely because the guardian is external to
  this system's identity model.
- **This context owns no audit table of its own.** Registration, role changes,
  consent changes, and DSAR actions are recorded through the same shared
  `recordAuditEvent()` → `identity.domain_events` (tagged `audit: true`) →
  `audit_log_writer` → `admin.audit_log` path every other context uses (ADR-0014).
  An `org_admin` reviewing identity-related history queries `admin.audit_log`
  directly via `admin`'s own read API — there is nothing schema-local to join.
