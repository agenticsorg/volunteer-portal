import { ProjectRoster } from "@/components/project-roster";

export default async function ProjectRosterPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-[#faf8f3] p-16">
      <div className="flex w-full max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[#1a2a3a]">Project roster</h1>
        <p className="text-sm text-[#1a2a3a]">
          Review applicants and manage who is assigned to this project.
        </p>
      </div>
      <ProjectRoster projectId={projectId} />
    </main>
  );
}
