-- Prompt 1.2: the event-hours trigger. Defense-in-depth mirror of
-- HourEntry::log's application-layer invariant (built in Prompt 4.1):
-- an hour_entry can only ever reference an assignment whose
-- participation_mode is 'contributor' (amended ADR-0006). This must
-- never diverge from the Rust-layer rule — both enforce the exact same
-- fact, independently.

create or replace function hour_entry_requires_contributor_assignment()
returns trigger
language plpgsql
as $$
declare
    mode text;
begin
    select participation_mode into mode
    from assignment
    where id = new.assignment_id;

    if mode is distinct from 'contributor' then
        raise exception
            'hour_entry.assignment_id must reference a contributor-mode assignment (found: %) — ADR-0006',
            mode;
    end if;

    return new;
end;
$$;

create trigger hour_entry_requires_contributor_assignment_trg
    before insert on hour_entry
    for each row
    execute function hour_entry_requires_contributor_assignment();
