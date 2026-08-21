import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @volunteer-portal/ulid and @volunteer-portal/audit ship TypeScript
  // source (no build step) — Next must transpile them like first-party
  // code rather than treating them as pre-built node_modules packages.
  transpilePackages: ["@volunteer-portal/ulid", "@volunteer-portal/audit", "@volunteer-portal/observability"],
};

export default nextConfig;
