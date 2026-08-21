/**
 * Thin wrapper around ruvector's bundled ONNX embedder
 * (all-MiniLM-L6-v2, 384 dimensions, pure WASM, no external API calls --
 * per ADR-0013's "read-only ... does not hold its own copy of
 * authorization-sensitive state": this module never touches a database,
 * only ever embeds text it's handed directly in a request body).
 *
 * The model downloads from HuggingFace on first use and is cached under
 * `.ruvector/models/` -- `init()` is called once at server startup
 * (server.ts) so the ~2s first-load cost happens before this service
 * starts accepting traffic, not on the first request.
 */
// Deep subpath import: ruvector's package root only re-exports the
// hash-based fallback providers (`services/embedding-service.ts`'s
// `LocalNGramProvider`/`MockEmbeddingProvider`), not the real
// transformer embedder -- `OnnxEmbedder` is reached this way instead,
// verified working against ruvector@0.3.0.
import { OnnxEmbedder } from "ruvector/dist/core/onnx-embedder.js";

export const EMBEDDING_DIMENSIONS = 384;

let embedder: OnnxEmbedder | null = null;

export async function initEmbedder(): Promise<void> {
  if (embedder) return;
  const instance = new OnnxEmbedder();
  const ready = await instance.init();
  if (!ready) {
    throw new Error("ruvector ONNX embedder failed to initialize");
  }
  if (instance.dimension !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `unexpected embedding dimension ${instance.dimension}, expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  embedder = instance;
}

function requireEmbedder(): OnnxEmbedder {
  if (!embedder) {
    throw new Error("embedder not initialized -- call initEmbedder() first");
  }
  return embedder;
}

export async function embedText(text: string): Promise<number[]> {
  return requireEmbedder().embed(text);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  return requireEmbedder().embedBatch(texts);
}

export function isEmbedderReady(): boolean {
  return embedder !== null;
}
