"use client";

import { useEffect, useState } from "react";

import type { AssignmentActionRequest } from "@/generated/AssignmentActionRequest";
import type { AssignmentDto } from "@/generated/Assignment";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

type LoadStatus = "loading" | "error" | "done";

/**
 * concept.md section 4's lead roster view: applicants and current roster
 * for one project, with approve/remove actions. Only reachable by a
 * project lead -- the backend's `LeadOf` extractor is the actual
 * authorization boundary (ADR-0002); a non-lead's fetch here simply
 * comes back 403 and this renders the same error state as any other
 * failed load, rather than this component attempting its own
 * authorization decision.
 */
export function ProjectRoster({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<AssignmentDto[]>([]);

  // Deliberately doesn't call `setStatus("loading")` at its own start --
  // the initial-mount case already begins in the "loading" state, and
  // the reload-after-action case (`act`, below) sets it explicitly
  // itself, from an event handler rather than an effect.
  async function fetchRoster() {
    try {
      const response = await fetch(`${API_BASE_URL}/projects/${projectId}/roster`, {
        credentials: "include",
      });
      if (!response.ok) {
        setStatus("error");
        setError(
          response.status === 403
            ? "Only this project's leads can view the roster."
            : "Couldn't load the roster. Please try again.",
        );
        return;
      }
      const results: AssignmentDto[] = await response.json();
      setAssignments(results);
      setStatus("done");
      setError(null);
    } catch {
      setStatus("error");
      setError("Couldn't load the roster. Please try again.");
    }
  }

  useEffect(() => {
    // Fetch-on-mount: no data-fetching library (SWR/React Query) is a
    // dependency of this project, so this is the plain fetch-in-effect
    // idiom rather than the rule's cascading-render concern (there's no
    // synchronous setState call in this function's own body -- every
    // `setStatus`/`setAssignments` call here happens after an `await`).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function act(assignmentId: string, action: "approve" | "remove") {
    const payload: AssignmentActionRequest = {
      assignment_id: assignmentId,
      reason: action === "remove" ? "Removed by project lead" : null,
    };
    const response = await fetch(
      `${API_BASE_URL}/projects/${projectId}/assignments/${action}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (response.ok) {
      setStatus("loading");
      await fetchRoster();
    }
  }

  if (status === "loading") {
    return (
      <p role="status" className="text-sm text-[#1a2a3a]">
        Loading roster…
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

  if (assignments.length === 0) {
    return (
      <p role="status" className="text-sm text-[#1a2a3a]">
        No one has applied to this project yet.
      </p>
    );
  }

  return (
    <table className="w-full max-w-3xl border-collapse text-left">
      <caption className="sr-only">Roster of applicants and members for this project</caption>
      <thead>
        <tr className="border-b border-zinc-300">
          <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
            Role
          </th>
          <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
            Status
          </th>
          <th scope="col" className="p-2 text-sm font-medium text-[#1a2a3a]">
            Actions
          </th>
        </tr>
      </thead>
      <tbody>
        {assignments.map((assignment) => (
          <tr key={assignment.id} className="border-b border-zinc-200">
            <td className="p-2 text-sm text-[#1a2a3a]">{assignment.role}</td>
            <td className="p-2 text-sm text-[#1a2a3a]">{assignment.status}</td>
            <td className="p-2 text-sm">
              <div className="flex gap-2">
                {assignment.status === "applied" ? (
                  <button
                    type="button"
                    onClick={() => act(assignment.id, "approve")}
                    className="rounded bg-[#ff5a1f] px-3 py-1 font-medium text-white"
                  >
                    Approve{" "}
                    <span className="sr-only">{assignment.role} application</span>
                  </button>
                ) : null}
                {assignment.status !== "removed" ? (
                  <button
                    type="button"
                    onClick={() => act(assignment.id, "remove")}
                    className="rounded border border-zinc-400 px-3 py-1 font-medium text-[#1a2a3a]"
                  >
                    Remove{" "}
                    <span className="sr-only">{assignment.role} from project</span>
                  </button>
                ) : null}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
