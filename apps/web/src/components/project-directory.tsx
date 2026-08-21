"use client";

import * as Label from "@radix-ui/react-label";
import { useId, useState } from "react";

import type { ApplyToProjectRequest } from "@/generated/ApplyToProjectRequest";
import type { ProjectSummaryDto } from "@/generated/ProjectSummary";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

type SearchStatus = "idle" | "loading" | "error" | "done";

/**
 * concept.md section 4's project directory: search by skill (the only
 * search dimension the backend's `find_open_by_skill` supports -- Prompt
 * 3.1), then apply with a role. Search results only appear once a skill
 * has been submitted (no auto-fetch on mount), so the accessibility test
 * suite can render this component without needing to mock `fetch`.
 */
export function ProjectDirectory() {
  const [skill, setSkill] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummaryDto[]>([]);

  const skillId = useId();

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = skill.trim();
    if (trimmed.length === 0) {
      return;
    }
    setStatus("loading");
    setError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/projects?skill=${encodeURIComponent(trimmed)}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        setStatus("error");
        setError("Couldn't load projects. Please try again.");
        return;
      }
      const results: ProjectSummaryDto[] = await response.json();
      setProjects(results);
      setStatus("done");
    } catch {
      setStatus("error");
      setError("Couldn't load projects. Please try again.");
    }
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <form onSubmit={handleSearch} className="flex items-end gap-3" noValidate>
        <div className="flex flex-col gap-1">
          <Label.Root htmlFor={skillId} className="font-mono text-sm font-semibold text-foreground">
            Search by skill
          </Label.Root>
          <input
            id={skillId}
            name="skill"
            type="text"
            placeholder="Carpentry"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            className="rounded-lg border border-input bg-background px-4 py-2 font-mono text-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={status === "loading" || skill.trim().length === 0}
          className="rounded-full bg-primary px-6 py-2 font-mono text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {status === "loading" ? "Searching…" : "Search"}
        </button>
      </form>

      <div aria-live="polite">
        {status === "error" && error ? (
          <p role="alert" className="font-mono text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {status === "done" && projects.length === 0 ? (
          <p role="status" className="font-mono text-sm text-foreground">
            No open projects match that skill right now.
          </p>
        ) : null}
      </div>

      {projects.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummaryDto }) {
  const [role, setRole] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [error, setError] = useState<string | null>(null);

  const roleId = useId();
  const headingId = useId();

  async function handleApply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    const payload: ApplyToProjectRequest = { role };

    try {
      const response = await fetch(`${API_BASE_URL}/projects/${project.id}/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setStatus("error");
        setError(
          response.status === 400
            ? "This project isn't accepting applications right now."
            : "Something went wrong applying. Please try again.",
        );
        return;
      }
      setStatus("success");
    } catch {
      setStatus("error");
      setError("Something went wrong applying. Please try again.");
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div>
        <h2 id={headingId} className="font-sans text-xl font-semibold text-foreground">
          {project.name}
        </h2>
        <p className="font-mono text-sm text-foreground">
          {project.project_type === "event" ? "Event" : "Project"}
        </p>
      </div>

      {status === "success" ? (
        <p role="status" className="font-mono text-sm text-foreground">
          Application submitted -- the project lead will review it.
        </p>
      ) : (
        <form onSubmit={handleApply} className="flex items-end gap-3" noValidate>
          <div className="flex flex-col gap-1">
            <Label.Root htmlFor={roleId} className="font-mono text-sm font-semibold text-foreground">
              Role
            </Label.Root>
            <input
              id={roleId}
              name="role"
              type="text"
              required
              placeholder="Carpenter"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-lg border border-input bg-background px-4 py-2 font-mono text-foreground focus:border-primary focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={status === "submitting" || role.trim().length === 0}
            className="rounded-full bg-secondary px-6 py-2 font-mono text-sm font-bold text-secondary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {status === "submitting" ? "Applying…" : "Apply"}
          </button>
        </form>
      )}

      <div aria-live="polite">
        {status === "error" && error ? (
          <p role="alert" className="font-mono text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
