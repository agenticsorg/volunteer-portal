"use client";

import * as Checkbox from "@radix-ui/react-checkbox";
import * as Label from "@radix-ui/react-label";
import { useId, useState } from "react";

import type { CompleteOnboardingRequest } from "@/generated/CompleteOnboardingRequest";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

type FormState = {
  name: string;
  timezone: string;
  skills: string;
  countryRegion: string;
  codeOfConductAccepted: boolean;
  ipAgreementAccepted: boolean;
  ageAttestationConfirmed: boolean;
};

const initialState: FormState = {
  name: "",
  timezone: "",
  skills: "",
  countryRegion: "",
  codeOfConductAccepted: false,
  ipAgreementAccepted: false,
  ageAttestationConfirmed: false,
};

/**
 * concept.md section 3's signup form: name, timezone, skills, country/
 * region (ADR-0014), and the three mandatory agreements. Every field has
 * an explicit, associated <label> (via Radix Label's htmlFor, matching
 * each input's id) rather than relying on placeholder text or visual
 * proximity alone -- Prompt 2.3's WCAG 2.1 AA exit criterion depends on
 * this. Submission errors are announced via aria-live so a screen-reader
 * user isn't left wondering why nothing happened.
 */
export function OnboardingForm() {
  const [form, setForm] = useState<FormState>(initialState);
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [error, setError] = useState<string | null>(null);

  const nameId = useId();
  const timezoneId = useId();
  const skillsId = useId();
  const countryRegionId = useId();
  const codeOfConductId = useId();
  const ipAgreementId = useId();
  const ageAttestationId = useId();

  const allAgreementsAccepted =
    form.codeOfConductAccepted && form.ipAgreementAccepted && form.ageAttestationConfirmed;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    const payload: CompleteOnboardingRequest = {
      name: form.name,
      timezone: form.timezone,
      skills: form.skills
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      availability: {},
      country_region: form.countryRegion.trim().length > 0 ? form.countryRegion.trim() : null,
      code_of_conduct_accepted: form.codeOfConductAccepted,
      ip_agreement_accepted: form.ipAgreementAccepted,
      age_attestation_confirmed: form.ageAttestationConfirmed,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/volunteers/me/onboarding`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setStatus("error");
        setError(
          response.status === 400
            ? "All three agreements must be accepted to continue."
            : "Something went wrong submitting your profile. Please try again.",
        );
        return;
      }
      setStatus("success");
    } catch {
      setStatus("error");
      setError("Something went wrong submitting your profile. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <p role="status" className="text-[#1a2a3a]">
        Thanks! Your profile is complete and waiting on admin approval.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={nameId} className="text-sm font-medium text-[#1a2a3a]">
          Name
        </Label.Root>
        <input
          id={nameId}
          name="name"
          type="text"
          required
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className="rounded border border-zinc-400 px-3 py-2"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={timezoneId} className="text-sm font-medium text-[#1a2a3a]">
          Timezone
        </Label.Root>
        <input
          id={timezoneId}
          name="timezone"
          type="text"
          required
          placeholder="America/Toronto"
          value={form.timezone}
          onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
          className="rounded border border-zinc-400 px-3 py-2"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={skillsId} className="text-sm font-medium text-[#1a2a3a]">
          Skills (comma-separated)
        </Label.Root>
        <input
          id={skillsId}
          name="skills"
          type="text"
          placeholder="React, Figma"
          value={form.skills}
          onChange={(e) => setForm((f) => ({ ...f, skills: e.target.value }))}
          className="rounded border border-zinc-400 px-3 py-2"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={countryRegionId} className="text-sm font-medium text-[#1a2a3a]">
          Country / region
        </Label.Root>
        <input
          id={countryRegionId}
          name="country_region"
          type="text"
          placeholder="CA-ON"
          value={form.countryRegion}
          onChange={(e) => setForm((f) => ({ ...f, countryRegion: e.target.value }))}
          className="rounded border border-zinc-400 px-3 py-2"
        />
      </div>

      <fieldset className="flex flex-col gap-3 rounded border border-zinc-300 p-4">
        <legend className="px-1 text-sm font-medium text-[#1a2a3a]">Agreements</legend>

        <div className="flex items-start gap-2">
          <Checkbox.Root
            id={codeOfConductId}
            required
            checked={form.codeOfConductAccepted}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, codeOfConductAccepted: checked === true }))
            }
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-400 bg-white data-[state=checked]:bg-[#ff5a1f]"
          >
            <Checkbox.Indicator className="text-white">✓</Checkbox.Indicator>
          </Checkbox.Root>
          <Label.Root htmlFor={codeOfConductId} className="text-sm text-[#1a2a3a]">
            I accept the code of conduct.
          </Label.Root>
        </div>

        <div className="flex items-start gap-2">
          <Checkbox.Root
            id={ipAgreementId}
            required
            checked={form.ipAgreementAccepted}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, ipAgreementAccepted: checked === true }))
            }
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-400 bg-white data-[state=checked]:bg-[#ff5a1f]"
          >
            <Checkbox.Indicator className="text-white">✓</Checkbox.Indicator>
          </Checkbox.Root>
          <Label.Root htmlFor={ipAgreementId} className="text-sm text-[#1a2a3a]">
            I accept the contribution / IP agreement.
          </Label.Root>
        </div>

        <div className="flex items-start gap-2">
          <Checkbox.Root
            id={ageAttestationId}
            required
            checked={form.ageAttestationConfirmed}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, ageAttestationConfirmed: checked === true }))
            }
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-400 bg-white data-[state=checked]:bg-[#ff5a1f]"
          >
            <Checkbox.Indicator className="text-white">✓</Checkbox.Indicator>
          </Checkbox.Root>
          <Label.Root htmlFor={ageAttestationId} className="text-sm text-[#1a2a3a]">
            I confirm that I am 18 years of age or older.
          </Label.Root>
        </div>
      </fieldset>

      <div aria-live="polite">
        {status === "error" && error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={status === "submitting" || !allAgreementsAccepted}
        className="rounded bg-[#ff5a1f] px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting…" : "Complete signup"}
      </button>
    </form>
  );
}
