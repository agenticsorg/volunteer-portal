import type { CurrentUser } from "@/generated/CurrentUser";
import { AccessibleCheckbox } from "@/components/accessible-checkbox";

// Referencing the ts-rs-generated type here is deliberate, not
// decorative: it's what proves a Rust apps/api response type change
// that isn't reflected here fails `tsc`, per ADR-0011's contract-drift
// mitigation. Real usage (fetching /auth/me and rendering it) lands
// with the onboarding/auth UI in Prompt 2.3.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type EnsureGeneratedTypesAreWired = CurrentUser;

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#faf8f3] p-16 font-sans">
      <h1 className="text-2xl font-semibold text-[#1a2a3a]">
        Agentics Foundation Volunteer Portal
      </h1>
      <p className="text-sm text-[#1a2a3a]">
        Frontend scaffold (Prompt 2.1) — Next.js + Radix UI, consuming
        generated types from the Rust API.
      </p>
      <AccessibleCheckbox />
    </div>
  );
}
