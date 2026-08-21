import Link from "next/link";

import type { CurrentUser } from "@/generated/CurrentUser";
import { SiteHeader } from "@/components/site-header";

// Referencing the ts-rs-generated type here is deliberate, not
// decorative: it's what proves a Rust apps/api response type change
// that isn't reflected here fails `tsc`, per ADR-0011's contract-drift
// mitigation. Real usage (fetching /auth/me and rendering it) lands
// with the onboarding/auth UI in Prompt 2.3.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type EnsureGeneratedTypesAreWired = CurrentUser;

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
        <p className="font-mono text-sm font-semibold uppercase tracking-widest text-primary">
          Agentics Foundation
        </p>
        <h1
          className="max-w-3xl font-sans font-semibold leading-tight text-foreground"
          style={{ fontSize: "clamp(32px, 6vw, 64px)" }}
        >
          Volunteer Portal
        </h1>
        <p className="max-w-xl font-mono text-base text-secondary">
          Sign up, apply to projects, log your hours, and track your contribution to the
          Agentics Foundation&apos;s open-source agentic AI work.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/onboarding"
            className="rounded-full bg-primary px-8 py-3 font-mono text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            href="/projects"
            className="rounded-full border border-border px-8 py-3 font-mono text-sm font-bold text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            Browse projects
          </Link>
        </div>
        <Link href="/privacy" className="mt-8 font-mono text-xs text-secondary underline underline-offset-4 hover:text-primary">
          Privacy Policy
        </Link>
      </main>
    </div>
  );
}
