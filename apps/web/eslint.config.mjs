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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { import: importPlugin },
    rules: {
      "import/no-restricted-paths": [
        "error",
        { zones: moduleBoundaryZones },
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
