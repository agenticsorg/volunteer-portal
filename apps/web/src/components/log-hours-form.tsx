"use client";

import * as Label from "@radix-ui/react-label";
import { useId, useState } from "react";

import type { LogHoursRequest } from "@/generated/LogHoursRequest";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

/**
 * concept.md section 5's self-logged entry: date, hours, short
 * description, against one assignment. Every field has an explicit
 * label; submission errors are announced via aria-live, matching the
 * onboarding form's established pattern. A 400 here (assignment not
 * eligible, e.g. an Attendee-mode event signup, or not currently
 * approved) is shown as a specific message rather than a generic error,
 * since the event-hours invariant is exactly the kind of thing a
 * volunteer needs to understand, not just retry against.
 */
export function LogHoursForm({ assignmentId }: { assignmentId: string }) {
  const [date, setDate] = useState("");
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [error, setError] = useState<string | null>(null);

  const dateId = useId();
  const hoursId = useId();
  const descriptionId = useId();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    const payload: LogHoursRequest = { date, hours, description };

    try {
      const response = await fetch(`${API_BASE_URL}/assignments/${assignmentId}/hours`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setStatus("error");
        setError(
          response.status === 400
            ? "This assignment isn't eligible for hours right now (it may not be an active contributor role, or hours may already be logged)."
            : response.status === 403
              ? "You can only log hours against your own assignment."
              : "Something went wrong logging your hours. Please try again.",
        );
        return;
      }
      setStatus("success");
    } catch {
      setStatus("error");
      setError("Something went wrong logging your hours. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <p role="status" className="font-mono text-foreground">
        Hours submitted -- the project lead will review them.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={dateId} className="font-mono text-sm font-semibold text-foreground">
          Date
        </Label.Root>
        <input
          id={dateId}
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-input bg-background px-4 py-2 font-mono text-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={hoursId} className="font-mono text-sm font-semibold text-foreground">
          Hours
        </Label.Root>
        <input
          id={hoursId}
          name="hours"
          type="number"
          step="0.25"
          min="0.25"
          max="24"
          required
          placeholder="2.5"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="rounded-lg border border-input bg-background px-4 py-2 font-mono text-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label.Root htmlFor={descriptionId} className="font-mono text-sm font-semibold text-foreground">
          What did you do?
        </Label.Root>
        <input
          id={descriptionId}
          name="description"
          type="text"
          required
          placeholder="Cleared brush along the east trail"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-lg border border-input bg-background px-4 py-2 font-mono text-foreground focus:border-primary focus:outline-none"
        />
      </div>

      <div aria-live="polite">
        {status === "error" && error ? (
          <p role="alert" className="font-mono text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={status === "submitting" || !date || !hours || !description}
        className="rounded-full bg-primary px-6 py-3 font-mono text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting…" : "Log hours"}
      </button>
    </form>
  );
}
