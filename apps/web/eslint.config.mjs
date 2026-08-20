import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import importPlugin from "eslint-plugin-import";

// The eight DDD bounded-context modules (docs/ddd/00-context-map.md),
// pre-wired per ADR-0001. Each module's public interface is its index.ts —
// nothing under domain/, application/, or infra/ may be imported by another
// module.
const BOUNDED_CONTEXTS = [
  "identity",
  "volunteering",
  "training",
  "gamification",
  "community",
  "moderation",
  "notifications",
  "admin",
];

const EVERY_MODULE_INTERNAL_PATH = BOUNDED_CONTEXTS.map((ctx) => `./src/modules/${ctx}/**/*`);

// One "zone" per module: code inside `modules/<m>/**` may only reach into
// another module (`modules/<other>/**`) via that module's index.ts barrel —
// everything else under `modules/<other>/**` is off limits. Importing
// *within* your own module is unrestricted (that module is excluded from its
// own `from` list).
const moduleBoundaryZones = BOUNDED_CONTEXTS.map((ctx) => ({
  target: `./src/modules/${ctx}/**/*`,
  from: BOUNDED_CONTEXTS.filter((other) => other !== ctx).map(
    (other) => `./src/modules/${other}/**/*`,
  ),
  except: ["**/index.ts"],
  message:
    "Cross-module imports must go through the target module's index.ts " +
    "public interface (ADR-0001) — importing an internal file " +
    "(domain/application/infra) of another bounded-context module directly " +
    "is not allowed.",
}));

// Reviewer-verified gap (Phase 2 adversarial review): the zones above only
// ever set `target: './src/modules/${ctx}/**/*'`, so the restriction only
// ever fires for files INSIDE src/modules/**. Code under src/app/** or
// src/server/** could deep-import any module's internal (non-index.ts)
// files with zero lint error — confirmed experimentally by the reviewer,
// and reproduced/fixed in this migration's own PR by adding a throwaway
// fixture route file doing exactly that, running eslint against it, and
// deleting it once the failure was confirmed. Two additional zones close
// this: `src/app/**` and `src/server/**` may only reach any module through
// its own index.ts barrel too, same as every other module already can only
// reach its siblings that way.
const outsideModuleZones = ["./src/app/**/*", "./src/server/**/*"].map((target) => ({
  target,
  from: EVERY_MODULE_INTERNAL_PATH,
  except: ["**/index.ts"],
  message:
    "Code outside src/modules/** must go through a bounded-context module's " +
    "index.ts public interface (ADR-0001) — importing an internal file " +
    "(domain/application/infra) of any module directly is not allowed here " +
    "either.",
}));

// Prisma models that belong to a single bounded context's own schema
// (`apps/web/prisma/schema.prisma`'s `@@schema("identity")` models) and
// must only ever be queried from within that context's own module.
// `import/no-restricted-paths` above only stops importing another module's
// *files* — it does nothing to stop code anywhere from reaching straight
// past every module's index.ts and querying `prisma.person` (or any other
// identity-schema model) directly via the shared `PrismaClient`, which has
// no module boundary of its own. Reviewer-verified gap, same review as
// above: a route file under src/app/** could do exactly that with zero
// lint error.
//
// Phase 2 only has one bounded context's models to protect this way
// (`identity`); this list grows as later phases add other contexts'
// Prisma models the same way.
const IDENTITY_ONLY_PRISMA_MODELS = [
  "person",
  "roleAssignment",
  "chapter",
  "consentRecord",
  "dSARRequest",
  "identityDomainEvent",
];

const identityPropertyPattern = `/^(${IDENTITY_ONLY_PRISMA_MODELS.join("|")})$/`;

// Matches `prisma.<model>` (the direct-import convention,
// `src/server/db/prisma.ts`) and `ctx.prisma.<model>` (the tRPC-context
// convention, `server/api/trpc.ts`) — the two ways this codebase actually
// names a `PrismaClient` handle outside a module's own application layer
// (module-internal code freely uses a `tx` parameter inside
// `prisma.$transaction(async (tx) => ...)`, which is legitimate there and
// exactly what this rule must NOT flag — hence scoping this rule's `files`
// to src/app/** and src/server/** only, never src/modules/**).
const identityPrismaModelSelector = [
  `MemberExpression[object.name='prisma'][property.name=${identityPropertyPattern}]`,
  `MemberExpression[object.property.name='prisma'][property.name=${identityPropertyPattern}]`,
].join(", ");

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { import: importPlugin },
    rules: {
      "import/no-restricted-paths": [
        "error",
        { zones: [...moduleBoundaryZones, ...outsideModuleZones] },
      ],
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: identityPrismaModelSelector,
          message:
            "Direct access to an identity-schema Prisma model " +
            `(${IDENTITY_ONLY_PRISMA_MODELS.join(", ")}) is not allowed outside ` +
            "src/modules/identity/** (ADR-0001) — go through modules/identity's " +
            "index.ts public interface (e.g. getPersonSummary, " +
            "listActiveRoleAssignments, requestErasure) instead of querying the " +
            "Prisma model directly.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
