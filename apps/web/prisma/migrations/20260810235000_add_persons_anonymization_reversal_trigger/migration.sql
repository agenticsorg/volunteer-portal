-- Person invariant 3 (docs/ddd/identity-access.md): "Status transitions
-- are one-directional: active <-> deactivated is reversible
-- (reactivation), but * -> anonymized is terminal -- no code path may set
-- status away from anonymized."
--
-- `chk_persons_anonymized_at` (the previous migration) only enforces that
-- `anonymized_at IS NOT NULL` iff `status = 'anonymized'` for a row's
-- CURRENT state -- it says nothing about what the PREVIOUS state was, so
-- it does not stop an UPDATE that simultaneously flips `status` back to
-- 'active' AND clears `anonymized_at` in the same statement (both columns
-- change together, so that CHECK is satisfied by the new row exactly as
-- much as by any other valid row). Confirmed directly:
--   UPDATE identity.persons SET status = 'active', anonymized_at = NULL
--     WHERE id = '<a previously anonymized person>';
--   -- succeeded; Person invariant 3 was silently violated.
--
-- Fixed here with the exact same pattern
-- `..._add_audit_log_and_domain_events/migration.sql` already established
-- for `admin.audit_log`'s own insert-only enforcement: a `plpgsql`
-- function that inspects the attempted change and `RAISE EXCEPTION`s, and
-- a `BEFORE UPDATE ... FOR EACH ROW` trigger that calls it -- fires
-- regardless of the connecting role's privileges (including a Postgres
-- superuser, the role every environment this migration currently runs
-- against actually connects as), which a `REVOKE`-only approach would not.
--
-- Unlike `audit_log`'s triggers (which reject every UPDATE unconditionally
-- -- that table is insert-only, full stop), `identity.persons` legitimately
-- has other UPDATE paths (profile edits, active <-> deactivated,
-- `AnonymizePerson` itself moving a row *into* 'anonymized' for the first
-- time). This trigger only rejects the two specific reversals Person
-- invariant 3 forbids: `status` moving away from 'anonymized' once it was
-- 'anonymized', and `anonymized_at` being cleared once it was set. Every
-- other UPDATE (including the `AnonymizePerson` transaction's own
-- anonymizing UPDATE, which only ever moves *into* that state) passes
-- through untouched.
CREATE FUNCTION "identity".persons_prevent_anonymization_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'anonymized' AND NEW.status <> 'anonymized' THEN
    RAISE EXCEPTION 'identity.persons anonymization is terminal: status cannot move away from ''anonymized'' once set (person %, attempted new status %)', OLD.id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.anonymized_at IS NOT NULL AND NEW.anonymized_at IS NULL THEN
    RAISE EXCEPTION 'identity.persons anonymization is terminal: anonymized_at cannot be cleared once set (person %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER persons_no_anonymization_reversal
  BEFORE UPDATE ON "identity"."persons"
  FOR EACH ROW EXECUTE FUNCTION "identity".persons_prevent_anonymization_reversal();
