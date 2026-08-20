"use client";

import { useEffect, useState } from "react";

import type { BulkApproveHoursRequest } from "@/generated/BulkApproveHoursRequest";
import type { BulkApproveHoursResult } from "@/generated/BulkApproveHoursResult";
import type { HourEntryDto } from "@/generated/HourEntry";
import type { RejectHoursRequest } from "@/generated/RejectHoursRequest";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

type LoadStatus = "loading" | "error" | "done";

/**
 * concept.md section 5's "lead approval queue with bulk approve" -- every
 * pending hour entry across every project the caller leads, with
 * checkboxes for a bulk-approve selection and a per-row reject action.
 * Authorization is enforced server-side (GET /hours/pending scopes to
 * the caller's own led projects; POST /hours/approve re-checks per
 * entry) -- this view doesn't attempt its own authorization decision,
 * consistent with the roster view's pattern.
 */
export function HoursApprovalQueue() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<HourEntryDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  async function fetchQueue() {
    try {
      const response = await fetch(`${API_BASE_URL}/hours/pending`, {
        credentials: "include",
      });
      if (!response.ok) {
        setStatus("error");
        setError("Couldn't load the approval queue. Please try again.");
        return;
      }
      const results: HourEntryDto[] = await response.json();
      setEntries(results);
      setSelected(new Set());
      setStatus("done");
    } catch {
      setStatus("error");
      setError("Couldn't load the approval queue. Please try again.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchQueue();
  }, []);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleBulkApprove() {
    setActionError(null);
    const payload: BulkApproveHoursRequest = { hour_entry_ids: Array.from(selected) };
    const response = await fetch(`${API_BASE_URL}/hours/approve`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      setActionError("Something went wrong approving those entries. Please try again.");
      return;
    }
    const result: BulkApproveHoursResult = await response.json();
    if (result.failed.length > 0) {
      setActionError(
        `${result.approved.length} approved, ${result.failed.length} could not be approved.`,
      );
    }
    await fetchQueue();
  }

  async function handleReject(id: string) {
    setActionError(null);
    const payload: RejectHoursRequest = { reason: null };
    const response = await fetch(`${API_BASE_URL}/hours/${id}/reject`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      setActionError("Something went wrong rejecting that entry. Please try again.");
      return;
    }
    await fetchQueue();
  }

  if (status === "loading") {
    return (
      <p role="status" className="text-sm text-[#1a2a3a]">
        Loading approval queue…
      </p>
    );
  }

  if (status === "error") {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p role="status" className="text-sm text-[#1a2a3a]">
        No pending hours to review right now.
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div aria-live="polite">
        {actionError ? (
          <p role="alert" className="text-sm text-red-700">
            {actionError}
          </p>
        ) : null}
      </div>

      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Pending hour entries awaiting approval</caption>
        <thead>
          <tr className="border-b border-zinc-300">
            <th scope="col" className="p-2">
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
              Date
            </th>
            <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
              Hours
            </th>
            <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
              Description
            </th>
            <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-zinc-200">
              <td className="p-2">
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggleSelected(entry.id)}
                  aria-label={`Select entry for ${entry.date}, ${entry.hours} hours`}
                />
              </td>
              <td className="p-2 text-sm text-[#1a2a3a]">{entry.date}</td>
              <td className="p-2 text-sm text-[#1a2a3a]">{entry.hours}</td>
              <td className="p-2 text-sm text-[#1a2a3a]">{entry.description}</td>
              <td className="p-2 text-sm">
                <button
                  type="button"
                  onClick={() => handleReject(entry.id)}
                  className="rounded border border-zinc-400 px-3 py-1 font-medium text-[#1a2a3a]"
                >
                  Reject{" "}
                  <span className="sr-only">
                    entry for {entry.date}, {entry.hours} hours
                  </span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button
        type="button"
        onClick={handleBulkApprove}
        disabled={selected.size === 0}
        className="w-fit rounded bg-[#ff5a1f] px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        Approve selected ({selected.size})
      </button>
    </div>
  );
}
