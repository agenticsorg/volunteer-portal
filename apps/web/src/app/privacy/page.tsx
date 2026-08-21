import Link from "next/link";

// Prompt 10.2 (build-roadmap.md Phase 10 exit criterion: "Privacy policy
// published with a stated retention period") and Prompt 10.3 (ADR-0014's
// GDPR Art. 27 exemption rationale, ADR-0015's breach-notification
// ownership) -- both ADRs require their rationale to be published here,
// not kept as an internal-only decision, since the exemption/ownership
// claims are meant to be demonstrable to a regulator or a volunteer who
// asks, not merely asserted internally.
//
// This is a first-draft policy written to accurately describe what this
// codebase actually does (RLS scoping, anonymize-not-delete, the
// data-subject-request endpoints) -- it is not a substitute for the
// Foundation's own legal review before this is treated as a binding
// public policy, and the Privacy Officer name below is a placeholder the
// Foundation must fill in (see this repo's compliance runbook).
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 bg-[#faf8f3] p-16 text-[#1a2a3a]">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-sm">
          This policy describes how the Agentics Foundation Volunteer Portal collects, uses, retains, and
          protects personal information, in accordance with Canada&apos;s Personal Information Protection
          and Electronic Documents Act (PIPEDA) and, for any volunteer resident in the European Union,
          the General Data Protection Regulation (GDPR).
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What we collect</h2>
        <p className="text-sm">
          At signup: your name, email address, Discord or Google identity, timezone, skills,
          availability, and country/region. During your time as a volunteer: project assignments,
          logged and approved hours, and your acceptances of the code of conduct, contribution/IP
          agreement, and age attestation, each with a timestamp.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Retention period</h2>
        <p className="text-sm">
          We retain your profile information for as long as your account is active, and for up to
          24 months after your last activity if you become inactive without requesting deletion.
        </p>
        <p className="text-sm">
          Records that document our own operations -- the audit log of admin actions and hour
          adjustments, approved hour entries, and assignment history -- are retained indefinitely as
          the Foundation&apos;s own compliance and recordkeeping evidence, independent of your account&apos;s
          status. This is why a deletion request anonymizes your profile rather than erasing these
          records outright: see &ldquo;How deletion requests work&rdquo; below.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Your rights: export and deletion</h2>
        <p className="text-sm">
          You may request a copy of the personal information we hold about you, or request that it be
          erased, at any time by signing in and filing a data-subject request from your account. An
          administrator will review and action every request; a rejection (permitted only for a live
          legal hold or an unresolved dispute directly involving your own records) will always include
          a written reason.
        </p>
        <h3 className="text-base font-semibold">How deletion requests work</h3>
        <p className="text-sm">
          We anonymize your profile rather than deleting the underlying row: your name, email, Discord
          link, skills, and country/region are irrecoverably overwritten, and your account is
          suspended. We do not delete your assignment history or approved hour entries, because those
          rows are also other volunteers&apos; project records and the Foundation&apos;s own compliance
          evidence -- they remain, attributed to an anonymized account rather than to you by name.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">EU volunteers and GDPR Article 27</h2>
        <p className="text-sm">
          The Foundation has not designated a standing EU representative under GDPR Article 27. We rely
          on the &ldquo;occasional, small-scale, low-risk processing&rdquo; exemption: our volunteer
          program is not EU-targeted, and any EU-resident volunteer&apos;s participation is incidental
          rather than the result of us actively offering services into the EU market. We monitor this
          continuously and will revisit this decision -- designating a representative -- the moment any
          one of the following becomes true: EU-resident approved volunteers exceed 10 individuals,
          the Foundation begins any deliberate EU-directed recruitment or project activity, or we begin
          processing any EU volunteer&apos;s special-category data beyond what onboarding already
          collects.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Data breach notification</h2>
        <p className="text-sm">
          The Foundation has designated a Privacy Officer accountable for triaging any suspected data
          incident, assessing whether it poses a real risk of significant harm, and notifying the
          Office of the Privacy Commissioner of Canada and affected individuals within the legally
          required timeframe when that threshold is met. Every incident, reportable or not, is
          recorded.
        </p>
        <p className="text-sm">
          Privacy Officer: <em>[to be designated by the Foundation]</em>. Contact:{" "}
          <em>[to be published once designated]</em>.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Security</h2>
        <p className="text-sm">
          All personal information is stored encrypted at rest, with automated, restore-tested backups.
          Access within the application is scoped per user via row-level security: a volunteer can see
          only their own record and public project listings; project leads and administrators have
          broader access strictly limited to what their role requires, and every administrative action
          and hour adjustment is written to an audit trail.
        </p>
      </section>

      <Link href="/" className="text-sm underline">
        Back to the volunteer portal
      </Link>
    </main>
  );
}
