// Server Component (RSC by default, per ADR-0002). No "use client" directive,
// no data fetching, no domain logic — this phase only stands up the container.
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-16 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">
        Agentics Foundation Volunteer Portal
      </h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Platform scaffold. Bounded-context modules and domain logic land in
        later phases.
      </p>
    </main>
  );
}
