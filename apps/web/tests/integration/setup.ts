/**
 * Vitest `globalSetup` for the "integration" project (ADR-0015
 * Implementation Notes: "tests/integration/setup.ts uses
 * `@testcontainers/postgresql` to start a `postgres:16` container, runs
 * `prisma migrate deploy` against it, then runs graphile-worker's schema
 * install (`graphile_worker.migrate()`) so outbox-drain tests have a real
 * job queue.").
 *
 * This starts exactly one disposable Postgres 16 container per
 * `pnpm test:integration` invocation (not per test file — `globalSetup`
 * runs once, before any integration test file is loaded), applies every
 * Prisma migration to it, and installs graphile-worker's own bookkeeping
 * schema. The container's connection string is published to every test
 * file via `process.env.DATABASE_URL`: `PrismaClient` and `pg.Client`
 * both read that at construction time, and — critically for
 * `auditLogWriter.integration.test.ts`, which spawns the real
 * `apps/worker` graphile-worker process — a spawned child inherits
 * `process.env` as of its own `spawn()` call, so it never sees the
 * developer's persistent docker-compose Postgres.
 *
 * This deliberately does NOT depend on `.env` / the docker-compose
 * Postgres at all — the harness is self-contained. `docker compose down -v`
 * followed by `pnpm test:integration` must still pass.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "graphile-worker";

// apps/web (this file lives at apps/web/tests/integration/setup.ts).
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const POSTGRES_IMAGE = "postgres:16";

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("volunteer_portal_test")
    .withUsername("volunteer_portal_test")
    .withPassword("volunteer_portal_test")
    .start();

  const connectionUri = container.getConnectionUri();

  // Every integration test file (and the real `apps/worker` process
  // `auditLogWriter.integration.test.ts` spawns) reads DATABASE_URL from
  // process.env — set it before any test file/worker is loaded so nothing
  // in this run can fall back to a developer's docker-compose Postgres.
  process.env.DATABASE_URL = connectionUri;

  // Apply every Prisma migration to the fresh container (ADR-0015: "runs
  // `prisma migrate deploy` against it").
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: WEB_ROOT,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "inherit",
  });

  // Install graphile-worker's own bookkeeping schema (ADR-0015: "runs
  // graphile-worker's schema install (`graphile_worker.migrate()`)") so
  // outbox-drain tests have a real job queue to run against. (The real
  // spawned worker process in auditLogWriter.integration.test.ts also
  // self-migrates on `run()`, but doing it here up front matches the
  // ADR's specified bootstrap exactly and means the schema exists even
  // for test files that never spawn the worker process.)
  await runMigrations({ connectionString: connectionUri });
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = undefined;
}
