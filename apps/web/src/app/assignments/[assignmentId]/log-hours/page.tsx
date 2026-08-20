import { LogHoursForm } from "@/components/log-hours-form";

export default async function LogHoursPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-[#faf8f3] p-16">
      <div className="flex w-full max-w-md flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[#1a2a3a]">Log your hours</h1>
        <p className="text-sm text-[#1a2a3a]">
          Record the date, hours, and what you worked on for this assignment.
        </p>
      </div>
      <LogHoursForm assignmentId={assignmentId} />
    </main>
  );
}
