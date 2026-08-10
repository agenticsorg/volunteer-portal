/**
 * tRPC HTTP adapter — mounts `appRouter` at `/api/trpc/[trpc]`, the only
 * endpoint the Next.js frontend uses to reach the backend (ADR-0003).
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });
}

export { handler as GET, handler as POST };
