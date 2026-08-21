import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Proves the module-boundary ESLint rules (apps/web/eslint.config.mjs,
 * ADR-0001) actually catch a violation — automated, wired into CI via
 * `pnpm test:unit`, replacing the "add a throwaway fixture file, run
 * eslint by hand, delete it" manual process the rule's own comments used
 * to describe as how it was last verified (Phase 0's original module
 * stub, Phase 2's reviewer-caught src/app/**+src/server/** gap).
 *
 * Uses ESLint's programmatic `lintText` API with a virtual `filePath` —
 * flat config resolves `files`/`ignores` glob matching against that path
 * exactly as it would a real file on disk, so no fixture file needs to
 * exist for the rule to fire (or not fire) against it.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");

async function lint(virtualRelativePath: string, source: string) {
  const eslint = new ESLint({ cwd: WEB_ROOT });
  const [result] = await eslint.lintText(source, {
    filePath: path.join(WEB_ROOT, virtualRelativePath),
  });
  return result.messages;
}

describe("module-boundary lint rules (ADR-0001)", () => {
  it("flags a direct cross-module Prisma model read from src/server/** (the Phase 2 reviewer-caught gap)", async () => {
    const messages = await lint(
      "src/server/__boundaryFixtureNeverWritten.ts",
      `import { prisma } from "@/server/db/prisma";\nexport async function leak() { return prisma.opportunity.findMany(); }\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("flags a direct cross-module Prisma model read from src/app/** the same way", async () => {
    const messages = await lint(
      "src/app/__boundaryFixtureNeverWritten/route.ts",
      `import { prisma } from "@/server/db/prisma";\nexport async function GET() { return prisma.badge.findMany(); }\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("flags one bounded context's module reading another context's Prisma model directly", async () => {
    const messages = await lint(
      "src/modules/volunteering/application/__boundaryFixtureNeverWritten.ts",
      `import { prisma } from "@/server/db/prisma";\nexport async function leak() { return prisma.badge.findMany(); }\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("flags a direct cross-module file import (not just a Prisma model read)", async () => {
    const messages = await lint(
      "src/modules/volunteering/application/__boundaryFixtureNeverWritten2.ts",
      `import { hasCompletedRequiredCourses } from "@/modules/training/application/hasCompletedRequiredCourses";\nexport { hasCompletedRequiredCourses };\n`,
    );
    expect(messages.some((m) => m.ruleId === "import/no-restricted-paths")).toBe(true);
  });

  it("does NOT flag a module reading its own schema's Prisma model directly", async () => {
    const messages = await lint(
      "src/modules/volunteering/application/__boundaryFixtureNeverWritten3.ts",
      `import { prisma } from "@/server/db/prisma";\nexport async function fine() { return prisma.opportunity.findMany(); }\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax" || m.ruleId === "import/no-restricted-paths")).toBe(
      false,
    );
  });

  it("does NOT flag a module's own transaction callback parameter named tx (must not false-positive on non-`prisma`-named handles)", async () => {
    const messages = await lint(
      "src/modules/volunteering/application/__boundaryFixtureNeverWritten4.ts",
      `import { prisma } from "@/server/db/prisma";\nexport async function fine() {\n  return prisma.$transaction(async (tx) => tx.opportunity.findMany());\n}\n`,
    );
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(false);
  });

  it("does NOT flag src/app or src/server importing a module through its own index.ts barrel", async () => {
    const messages = await lint(
      "src/server/__boundaryFixtureNeverWritten5.ts",
      `import { getPersonSummary } from "@/modules/identity";\nexport { getPersonSummary };\n`,
    );
    expect(messages.some((m) => m.ruleId === "import/no-restricted-paths")).toBe(false);
  });
});
