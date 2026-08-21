/**
 * POST /api/v1/webhooks/cloudflare-stream
 *
 * docs/ddd/training-learning.md's Integration & Anti-Corruption Notes:
 * "Cloudflare Stream calls a plain REST endpoint ... not tRPC." A thin
 * `await req.text()` + header read wrapper over `ingestVideoWebhook`
 * (`modules/training`) — that function owns every real piece of logic
 * (signature verification via the Cloudflare Stream adapter, payload
 * translation, idempotency, event emission); this route only adapts the
 * Next.js `Request` shape to the framework-agnostic
 * `{ rawBody, signatureHeader }` input the use case expects, exactly the
 * "use case owns the logic, the route is a thin adapter" split
 * `ingestVideoWebhook`'s own doc comment describes.
 *
 * Cloudflare retries on any non-2xx response, so response codes matter:
 * - 401 on a bad/missing signature (`WebhookSignatureInvalidError`) — a
 *   forged or malformed request Cloudflare should NOT keep retrying (a
 *   genuine Cloudflare delivery will never fail signature verification).
 * - 500 when this deployment has no `CLOUDFLARE_STREAM_WEBHOOK_SECRET`
 *   configured (`ExternalServiceNotConfiguredError`) — a real ops problem,
 *   worth Cloudflare's automatic retry once the secret is set.
 * - 200 on success, including every idempotent no-op case
 *   `ingestVideoWebhook` itself documents (unknown `uid`, duplicate
 *   delivery of an already-processed state) — those are not errors.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ingestVideoWebhook, WebhookSignatureInvalidError, ExternalServiceNotConfiguredError } from "@/modules/training";
import { prisma } from "@/server/db/prisma";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("webhook-signature");

  try {
    await ingestVideoWebhook(prisma, { rawBody, signatureHeader });
  } catch (error) {
    if (error instanceof WebhookSignatureInvalidError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ExternalServiceNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
