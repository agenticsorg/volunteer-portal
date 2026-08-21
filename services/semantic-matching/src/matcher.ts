/**
 * The matching core (ADR-0013): one HNSW-backed `VectorDb` per
 * collection ("projects" | "volunteers"), rebuilt whole on every
 * `/index` call, so the Rust caller is always the source of truth that
 * re-populates this on startup and whenever its underlying data
 * changes. This service never queries Postgres itself.
 *
 * Storage: `ruvector@0.3.0`'s `VectorDb` does NOT behave as
 * "omit `storagePath` for in-memory" the way its own README's basic
 * tutorial claims -- verified directly (not assumed): omitting it
 * silently falls back to a shared default on-disk store, and even an
 * *explicit* `storagePath` is cached internally by path string, so
 * deleting the file and constructing a "new" `VectorDb` at the same
 * path reuses the old (now-stale) backend rather than starting empty.
 * The only reliable isolation this library actually offers is a
 * genuinely distinct path per instance, so every `reindex()` call below
 * mints a fresh path (`data/<collection>-<uuid>.db`) and removes the
 * *previous* one only after the new index is live -- never a window
 * where the collection has no backing store.
 *
 * `VectorDb.search()`'s `score` is a cosine *distance*
 * (`1 - cosineSimilarity`), ascending / lower-is-better, already sorted
 * best-first -- also verified directly against actual behavior, not
 * assumed from docs that don't state this explicitly. `rankToSimilarity`
 * converts back to the conventional higher-is-better similarity score
 * this service's own HTTP API exposes, so callers never need to know
 * which convention the underlying library uses.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VectorDb, Utils } from "ruvector";
import { embedText, embedTexts, EMBEDDING_DIMENSIONS } from "./embedder.js";

export type Collection = "projects" | "volunteers";

export interface IndexItem {
  id: string;
  text: string;
}

export interface MatchResult {
  id: string;
  score: number;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

interface LiveIndex {
  db: InstanceType<typeof VectorDb>;
  storagePath: string;
}

const indexes = new Map<Collection, LiveIndex>();

function rankToSimilarity(distance: number): number {
  return 1 - distance;
}

/** Rebuilds `collection`'s index from scratch. Returns the item count. */
export async function reindex(collection: Collection, items: IndexItem[]): Promise<number> {
  const storagePath = join(DATA_DIR, `${collection}-${randomUUID()}.db`);
  const db = new VectorDb({ dimensions: EMBEDDING_DIMENSIONS, distanceMetric: "cosine", storagePath });
  if (items.length > 0) {
    const vectors = await embedTexts(items.map((item) => item.text));
    await db.insertBatch(items.map((item, i) => ({ id: item.id, vector: vectors[i] })));
  }

  const previous = indexes.get(collection);
  indexes.set(collection, { db, storagePath });
  if (previous) {
    rmSync(previous.storagePath, { force: true });
  }
  return items.length;
}

/** Ranks `collection`'s current index against `query`. Empty if the
 * collection has never been indexed (or was indexed with zero items). */
export async function match(collection: Collection, query: string, limit: number): Promise<MatchResult[]> {
  const live = indexes.get(collection);
  if (!live) return [];
  const queryVector = await embedText(query);
  const results = await live.db.search({ vector: queryVector, k: limit });
  return results.map((r) => ({ id: r.id, score: rankToSimilarity(r.score) }));
}

/**
 * Ad-hoc ranking over a caller-supplied candidate set, with no
 * dependency on a pre-built index -- backs the "which of *your own*
 * open assignments should this returning volunteer log hours against"
 * use case (concept.md section 10's second `ruvector` use case), where
 * the candidate set is already authorization-scoped by the Rust caller
 * (their own approved assignments) before it ever reaches this service.
 */
export async function matchCandidates(
  query: string,
  candidates: IndexItem[],
  limit: number,
): Promise<MatchResult[]> {
  if (candidates.length === 0) return [];
  const [queryVector, candidateVectors] = await Promise.all([
    embedText(query),
    embedTexts(candidates.map((c) => c.text)),
  ]);
  const scored: MatchResult[] = candidates.map((c, i) => ({
    id: c.id,
    score: Utils.cosineSimilarity(queryVector, candidateVectors[i]),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Test-only reset so each test file starts from a clean slate. */
export function _resetAllIndexesForTests(): void {
  for (const live of indexes.values()) {
    rmSync(live.storagePath, { force: true });
  }
  indexes.clear();
}
