/**
 * Resend integration (ADR-0012) — the only place in this module that talks
 * to Resend's transactional-email API or verifies its webhook signature.
 * Every other file in this module depends on the `ResendAdapter`
 * *interface* below, never on this file's concrete `fetch` calls directly,
 * so `ProcessDeliveryJob`/`HandleResendWebhook` stay testable without live
 * Resend credentials (inject a fake adapter in tests) — same adapter-
 * boundary shape as `training`'s `infra/cloudflareStreamClient.ts` and
 * `moderation`'s/`community`'s `infra/cloudflareR2Client.ts`.
 *
 * This environment has no Resend credentials configured (no `.env` with
 * real values). `sendTransactionalEmail` — the one function that would
 * need to make a live network call to Resend — throws
 * `ExternalServiceNotConfiguredError` naming the exact missing environment
 * variable (`RESEND_API_KEY`) whenever it's actually invoked; it never
 * fakes a successful send or returns a synthetic `providerMessageId`.
 * `verifyWebhookSignature` needs `RESEND_WEBHOOK_SECRET` and fails the
 * same way. The request-shape/signing logic itself is real and
 * independently testable (pure functions, no network call, given a fixed
 * input) — see `buildSendRequestBody`/the signature-parsing helpers below.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ExternalServiceNotConfiguredError } from "../domain/errors";

const RESEND_API_BASE = "https://api.resend.com";
/** ADR-0012's Implementation Notes: the sending identity every transactional email uses. */
const DEFAULT_FROM_ADDRESS = "Agentics Volunteer Portal <notifications@mail.volunteer.agentics.org>";

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ExternalServiceNotConfiguredError(name, purpose);
  }
  return value;
}

export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** `List-Unsubscribe`-style headers, keyed by header name — ADR-0012's unsubscribe-compliance note. */
  headers?: Record<string, string>;
}

export interface SendTransactionalEmailResult {
  /** Resend's own message id — persisted as `delivery_attempt.provider_message_id` for later webhook correlation. */
  providerMessageId: string;
}

/**
 * Resend's documented `svix-id` / `svix-timestamp` / `svix-signature`
 * webhook headers (Resend webhooks are Svix-delivered — ADR-0012:
 * "Verifies the Resend webhook signature (svix-style HMAC header)").
 */
export interface ResendWebhookHeaders {
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}

export interface ResendAdapter {
  sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<SendTransactionalEmailResult>;
  verifyWebhookSignature(rawBody: string, headers: ResendWebhookHeaders): boolean;
}

interface ResendSendEmailResponse {
  id: string;
}

/** Pure request-body builder — independently testable without a network call. */
export function buildSendRequestBody(input: SendTransactionalEmailInput): Record<string, unknown> {
  return {
    from: DEFAULT_FROM_ADDRESS,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
    headers: input.headers,
  };
}

/**
 * Svix's signing scheme: the secret is `whsec_<base64>`; the signed
 * content is `${svixId}.${svixTimestamp}.${rawBody}`, HMAC-SHA256'd with
 * the base64-decoded secret, base64-encoded, and compared against each
 * `v1,<signature>` entry in the space-separated `svix-signature` header
 * (Resend may send more than one signature during secret rotation).
 */
export function verifySvixSignature(
  rawBody: string,
  headers: ResendWebhookHeaders,
  secret: string,
): boolean {
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${headers.svixId}.${headers.svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest();

  return headers.svixSignature
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((sig): sig is string => Boolean(sig))
    .some((sig) => {
      const actual = Buffer.from(sig, "base64");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
}

export const resendAdapter: ResendAdapter = {
  async sendTransactionalEmail(input) {
    const apiKey = requireEnv("RESEND_API_KEY", "Sending a transactional email via Resend");

    const response = await fetch(`${RESEND_API_BASE}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildSendRequestBody(input)),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => response.statusText);
      throw new Error(`Resend send-email request failed (${response.status}): ${errorBody}`);
    }

    const result = (await response.json()) as ResendSendEmailResponse;
    return { providerMessageId: result.id };
  },

  verifyWebhookSignature(rawBody, headers) {
    const secret = requireEnv("RESEND_WEBHOOK_SECRET", "Verifying a Resend webhook signature");
    return verifySvixSignature(rawBody, headers, secret);
  },
};
