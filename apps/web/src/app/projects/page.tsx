import { SiteHeader } from "@/components/site-header";
import { ProjectDirectory } from "@/components/project-directory";

export default function ProjectsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center gap-8 px-6 py-16">
        <div className="flex w-full max-w-2xl flex-col gap-2">
          <h1 className="font-sans text-3xl font-semibold text-foreground">Find a project</h1>
          <p className="font-mono text-sm text-secondary">
            Search open projects and events by skill, then apply directly.
          </p>
        </div>
        <ProjectDirectory />
      </main>
    </div>
  );
}
