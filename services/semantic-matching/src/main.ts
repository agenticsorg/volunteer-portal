/** Process entry point (`npm start`). `server.ts`'s `createApp()` is the
 * part tests import directly, so tests never bind a real port. */
import { createApp } from "./server.js";
import { initEmbedder } from "./embedder.js";

const PORT = Number(process.env.PORT ?? 8081);

async function main() {
  // eslint-disable-next-line no-console
  console.log("semantic-matching: loading embedder...");
  await initEmbedder();
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`semantic-matching: listening on :${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("semantic-matching: fatal startup error", err);
  process.exit(1);
});
