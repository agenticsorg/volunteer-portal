import { SiteHeader } from "@/components/site-header";
import { LogHoursForm } from "@/components/log-hours-form";

export default async function LogHoursPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center gap-8 px-6 py-16">
        <div className="flex w-full max-w-md flex-col gap-2">
          <h1 className="font-sans text-3xl font-semibold text-foreground">Log your hours</h1>
          <p className="font-mono text-sm text-secondary">
            Record the date, hours, and what you worked on for this assignment.
          </p>
        </div>
        <LogHoursForm assignmentId={assignmentId} />
      </main>
    </div>
  );
}
