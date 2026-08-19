-- Prompt 2.3, per ADR-0014: adds the country/region field to the signup
-- form now, even though ADR-0014's own monitoring obligation (the
-- 10-EU-volunteer trigger) is nominally a Phase 10 concern -- without
-- this column now, Phase 10 has no historical data to check.
alter table volunteer add column country_region text;
