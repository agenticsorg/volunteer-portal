import { PrismaClient } from "@prisma/client";

/**
 * The one `PrismaClient` this Next.js process shares across requests.
 *
 * Cached on `globalThis` in development only, so Next's hot-module-reload
 * doesn't open a fresh Postgres connection pool on every edit (the
 * well-known Next.js + Prisma dev-mode pattern). Production/test each get
 * exactly one instance for the life of the process either way.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
