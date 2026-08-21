import { SiteHeader } from "@/components/site-header";
import { ProjectRoster } from "@/components/project-roster";

export default async function ProjectRosterPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center gap-8 px-6 py-16">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <h1 className="font-sans text-3xl font-semibold text-foreground">Project roster</h1>
          <p className="font-mono text-sm text-secondary">
            Review applicants and manage who is assigned to this project.
          </p>
        </div>
        <ProjectRoster projectId={projectId} />
      </main>
    </div>
  );
}
