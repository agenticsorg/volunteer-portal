-- Prompt 3.1: migration 0004 granted select/insert/update on project_lead
-- but never delete, even though migration 0002 already defines the
-- project_lead_delete RLS policy in anticipation of it -- unlike
-- volunteer/assignment/hour_entry (which use status-based soft removal),
-- project_lead rows are physically deleted when a co-lead is removed
-- (projects-assignments.md's ProjectLeadRemoved event), and
-- Project::remove_lead's invariant (at least one lead must always
-- remain) is exactly what makes an unrestricted DELETE grant safe here.
grant delete on project_lead to app_user;
