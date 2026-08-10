-- Baseline migration (Phase 0: platform bootstrap).
--
-- Creates the eight Postgres schemas that back the eight DDD bounded
-- contexts (docs/ddd/00-context-map.md), one per ADR-0001's "Modular
-- Monolith with One Postgres Schema per Bounded Context". No tables yet
-- — domain modeling starts in a later phase.
--
-- Hand-authored rather than `prisma migrate dev`-generated: with zero
-- models declared in schema.prisma, Prisma's schema-diff engine has
-- nothing to diff against and will not emit `CREATE SCHEMA` statements
-- for the schemas named in the datasource's `schemas` array, even though
-- Prisma Migrate still applies, tracks, and can diff-check this file like
-- any other migration once it exists (`prisma migrate dev` /
-- `prisma migrate deploy` / `prisma migrate diff` all treat it normally).
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS volunteering;
CREATE SCHEMA IF NOT EXISTS training;
CREATE SCHEMA IF NOT EXISTS gamification;
CREATE SCHEMA IF NOT EXISTS community;
CREATE SCHEMA IF NOT EXISTS moderation;
CREATE SCHEMA IF NOT EXISTS notifications;
CREATE SCHEMA IF NOT EXISTS admin;
