/**
 * Prompt 9.1: the semantic-matching service's HTTP surface. Called by
 * the Rust backend over an internal API (ADR-0013) -- never exposed
 * directly to end users, never given a database connection, never told
 * anything about authorization. Every request/response body here is
 * just `{id, text}`/`{id, score}` pairs; no volunteer/project identity
 * semantics live in this service at all.
 */
import express, { type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { match, matchCandidates, reindex, type Collection, type IndexItem } from "./matcher.js";
import { isEmbedderReady } from "./embedder.js";

/**
 * Express 4 does not forward a rejected promise from an `async` handler
 * to the error middleware on its own -- without this, an embedder
 * failure would surface as an unhandled rejection instead of a clean
 * 500 (the module doc comment's whole point).
 */
function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function isCollection(value: unknown): value is Collection {
  return value === "projects" || value === "volunteers";
}

function isIndexItemArray(value: unknown): value is IndexItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as IndexItem).id === "string" &&
        typeof (item as IndexItem).text === "string",
    )
  );
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", embedderReady: isEmbedderReady() });
  });

  app.post(
    "/index",
    asyncHandler(async (req, res) => {
      const { collection, items } = req.body ?? {};
      if (!isCollection(collection)) {
        res.status(400).json({ error: "collection must be 'projects' or 'volunteers'" });
        return;
      }
      if (!isIndexItemArray(items)) {
        res.status(400).json({ error: "items must be an array of {id: string, text: string}" });
        return;
      }
      const count = await reindex(collection, items);
      res.json({ collection, count });
    }),
  );

  app.post(
    "/match",
    asyncHandler(async (req, res) => {
      const { collection, query, limit } = req.body ?? {};
      if (!isCollection(collection)) {
        res.status(400).json({ error: "collection must be 'projects' or 'volunteers'" });
        return;
      }
      if (typeof query !== "string" || query.trim().length === 0) {
        res.status(400).json({ error: "query must be a non-empty string" });
        return;
      }
      const resolvedLimit = typeof limit === "number" && limit > 0 ? Math.min(limit, 100) : 10;
      const results = await match(collection, query, resolvedLimit);
      res.json({ results });
    }),
  );

  app.post(
    "/match-candidates",
    asyncHandler(async (req, res) => {
      const { query, candidates, limit } = req.body ?? {};
      if (typeof query !== "string" || query.trim().length === 0) {
        res.status(400).json({ error: "query must be a non-empty string" });
        return;
      }
      if (!isIndexItemArray(candidates)) {
        res.status(400).json({ error: "candidates must be an array of {id: string, text: string}" });
        return;
      }
      const resolvedLimit = typeof limit === "number" && limit > 0 ? Math.min(limit, 100) : 10;
      const results = await matchCandidates(query, candidates, resolvedLimit);
      res.json({ results });
    }),
  );

  // Deliberately last: any unhandled error (including an embedder that
  // failed to initialize) becomes a clean 500, never an unhandled
  // rejection that crashes the process -- the Rust caller's own
  // deterministic-SQL fallback (Prompt 9.1's explicit requirement) is
  // what actually keeps the user-facing directory search working when
  // this service is unavailable, but this service itself should still
  // fail cleanly rather than crash.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
