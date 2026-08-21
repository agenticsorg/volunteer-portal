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
// (`apps/web/prisma/schema.prisma`'s `@@schema("<context>")` models) and
// must only ever be queried from within that context's own module.
// `import/no-restricted-paths` above only stops importing another module's
// *files* — it does nothing to stop code anywhere from reaching straight
// past every module's index.ts and querying `prisma.person` (or any other
// context's model) directly via the shared `PrismaClient`, which has no
// module boundary of its own. Reviewer-verified gap, Phase 2's review: a
// route file under src/app/** could do exactly that with zero lint error.
//
// Phase 11 audit (docs/plans/implementation-plan.md's launch-readiness
// item 3: "an automated CI check ... that fails the build if ... any
// direct cross-module Prisma import has crept in") found this map had
// never actually grown past Phase 2's original identity-only list despite
// the comment here promising it would — seven bounded contexts' worth of
// models (volunteering/training/gamification/community/moderation/
// notifications/admin, ~49 models) had zero enforcement. No violation
// existed in the codebase at audit time (verified by grep across every
// src/modules/** file), but the *check* itself was silently incomplete —
// a future PR could have introduced one with a green lint run. This map
// is now complete across all eight contexts; keep it that way as new
// schemas/models are added.
const SCHEMA_MODELS = {
  identity: ["person", "roleAssignment", "chapter", "consentRecord", "dSARRequest", "identityDomainEvent"],
  volunteering: ["opportunity", "shift", "application", "hourEntry", "volunteeringDomainEvent"],
  training: [
    "course",
    "module",
    "modulePrerequisite",
    "video",
    "enrollment",
    "moduleProgress",
    "quiz",
    "quizQuestion",
    "quizChoice",
    "quizAttempt",
    "quizAttemptAnswer",
    "certificate",
    "trainingDomainEvent",
  ],
  gamification: [
    "pointsLedgerEntry",
    "pointsBalance",
    "badge",
    "badgeAward",
    "streak",
    "leaderboardSnapshot",
    "gamificationDomainEvent",
    "gamificationProcessedEvent",
  ],
  community: [
    "post",
    "feedEntry",
    "kudos",
    "team",
    "teamMembership",
    "mentorship",
    "communityDomainEvent",
    "communityProcessedEvent",
  ],
  moderation: ["report", "moderationAction", "moderationDomainEvent"],
  notifications: [
    "notification",
    "notificationPreference",
    "deliveryAttempt",
    "notificationsDomainEvent",
    "notificationsProcessedEvent",
  ],
  admin: ["auditLog", "reportDefinition", "exportJob", "retentionPolicy", "adminDomainEvent", "adminProcessedEvent"],
};

const ALL_SCHEMA_MODELS = Object.values(SCHEMA_MODELS).flat();

// Matches `prisma.<model>` (the direct-import convention,
// `src/server/db/prisma.ts`) and `ctx.prisma.<model>` (the tRPC-context
// convention, `server/api/trpc.ts`) — the two ways this codebase actually
// names a `PrismaClient` handle outside a module's own application layer
// (module-internal code freely uses a `tx` parameter inside
// `prisma.$transaction(async (tx) => ...)`, which is legitimate there and
// exactly what this selector must NOT flag — it only ever matches the
// literal identifier `prisma`, never `tx`, so it's safe to apply inside
// src/modules/** too, not just src/app/**+src/server/**).
function prismaModelSelector(modelNames) {
  const pattern = `/^(${modelNames.join("|")})$/`;
  return [
    `MemberExpression[object.name='prisma'][property.name=${pattern}]`,
    `MemberExpression[object.property.name='prisma'][property.name=${pattern}]`,
  ].join(", ");
}

// One rule per bounded context: code inside modules/<ctx>/** may directly
// query its OWN schema's models (that's ordinary, unrestricted application
// code) but not another context's — the actual "cross-module Prisma
// import" case ADR-0001/the launch-readiness audit names. Verified via
// grep at the time this was added: zero existing violations, this is
// pure hardening against future regressions, not a fix for a live bug.
const crossModulePrismaZones = Object.keys(SCHEMA_MODELS).map((ctx) => {
  const otherContextModels = Object.entries(SCHEMA_MODELS)
    .filter(([owner]) => owner !== ctx)
    .flatMap(([, models]) => models);
  return {
    files: [`src/modules/${ctx}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: prismaModelSelector(otherContextModels),
          message:
            `Code inside modules/${ctx}/** may only directly query ${ctx}'s own schema's ` +
            "Prisma models (ADR-0001) — reading another bounded context's model directly " +
            "is not allowed here either; go through that module's index.ts public " +
            "interface instead.",
        },
      ],
    },
  };
});

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
  ...crossModulePrismaZones,
  {
    files: ["src/app/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: prismaModelSelector(ALL_SCHEMA_MODELS),
          message:
            "Direct access to a bounded-context Prisma model is not allowed outside " +
            "its own src/modules/<context>/** (ADR-0001) — go through that module's " +
            "index.ts public interface (e.g. identity's getPersonSummary, " +
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
