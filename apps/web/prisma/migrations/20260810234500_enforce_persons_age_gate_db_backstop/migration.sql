-- Fixes a real, verified gap in `chk_persons_age_gate`
-- (docs/ddd/identity-access.md Person invariant 2; the previous migration's
-- own version, reproduced verbatim in
-- `..._add_identity_aggregates/migration.sql`):
--
--   ALTER TABLE identity.persons ADD CONSTRAINT chk_persons_age_gate CHECK (
--     status = 'anonymized'
--     OR date_of_birth IS NOT NULL
--     OR age_attested_16_plus = true
--   );
--
-- only checked that a `date_of_birth` value was PRESENT, never that it
-- actually implies the registrant is 16 or older. A self-reported
-- 8-year-old's `date_of_birth` satisfies "IS NOT NULL" trivially, so this
-- CHECK let that row through with zero guardian consent — confirmed
-- directly:
--   INSERT INTO identity.persons (..., date_of_birth, age_attested_16_plus, ...)
--     VALUES (..., DATE '2018-01-01', false, ...);  -- age 8 as of this
--   -- migration's date; the old CHECK passed it anyway.
--
-- Fixed below with real date arithmetic. The one legitimate case a plain
-- CHECK genuinely cannot express -- an accurately-recorded under-16 DOB
-- backed by an *active* `guardian_consent` ConsentRecord (Person invariant
-- 2's third clause) -- requires looking at `identity.consent_records`, a
-- different table, which Postgres CHECK constraints are explicitly
-- documented not to support ("CHECK expressions cannot contain
-- subqueries"; Postgres's own recommendation for this exact situation is
-- "create a trigger instead"). A `CONSTRAINT TRIGGER` is the correct tool
-- here (same "trigger over CHECK where CHECK can't reach" precedent this
-- migration set already exists for `admin.audit_log`'s insert-only
-- enforcement) and, being `DEFERRABLE INITIALLY DEFERRED`, evaluates at
-- transaction COMMIT rather than immediately per-statement -- required
-- because `registerPerson.ts` must insert the `persons` row *before* the
-- `consent_records` row referencing it (`consent_records.person_id`'s FK),
-- so an immediately-checked trigger would never see the guardian consent
-- row it needs to look at; a deferred one, firing after both statements in
-- the same transaction have run, does.
ALTER TABLE "identity"."persons" DROP CONSTRAINT "chk_persons_age_gate";

CREATE FUNCTION "identity".enforce_persons_age_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  has_active_guardian_consent boolean;
BEGIN
  -- Anonymization scrubs date_of_birth to NULL and is this invariant's own
  -- documented exception (Person invariant 2 / the original CHECK's third
  -- clause).
  IF NEW.status = 'anonymized' THEN
    RETURN NULL;
  END IF;

  -- Explicit 16+ self-attestation satisfies the gate outright.
  IF NEW.age_attested_16_plus = true THEN
    RETURN NULL;
  END IF;

  -- Real date arithmetic: a date_of_birth on or before "16 years ago
  -- today" implies the registrant has actually turned 16, not merely that
  -- some date value was supplied.
  IF NEW.date_of_birth IS NOT NULL AND NEW.date_of_birth <= (CURRENT_DATE - INTERVAL '16 years') THEN
    RETURN NULL;
  END IF;

  -- The remaining legitimate path (Person invariant 2's third clause): an
  -- under-16 (or missing) date_of_birth backed by at least one *active*
  -- (revoked_at IS NULL) guardian_consent ConsentRecord for this exact
  -- person, inserted in the same transaction as this row.
  SELECT EXISTS (
    SELECT 1 FROM "identity"."consent_records"
    WHERE "person_id" = NEW.id
      AND "purpose" = 'guardian_consent'
      AND "revoked_at" IS NULL
  ) INTO has_active_guardian_consent;

  IF has_active_guardian_consent THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'identity.persons age gate violated for person %: requires date_of_birth implying >= 16 years old, age_attested_16_plus = true, or an active guardian_consent ConsentRecord (chk_persons_age_gate, identity-access.md Person invariant 2)',
    NEW.id
    USING ERRCODE = 'check_violation';
END;
$$;

-- Named `chk_persons_age_gate`, same name as the CHECK it replaces, so
-- this remains "the age-gate constraint" by name even though the
-- mechanism backing it changed from an immediate CHECK to a deferred
-- constraint trigger (documented in
-- information_schema.table_constraints/pg_constraint the same as any
-- other named table constraint).
CREATE CONSTRAINT TRIGGER "chk_persons_age_gate"
  AFTER INSERT OR UPDATE OF "date_of_birth", "age_attested_16_plus", "status" ON "identity"."persons"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "identity".enforce_persons_age_gate();
