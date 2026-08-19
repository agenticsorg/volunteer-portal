import { ProjectDirectory } from "@/components/project-directory";

export default function ProjectsPage() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-[#faf8f3] p-16">
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[#1a2a3a]">Find a project</h1>
        <p className="text-sm text-[#1a2a3a]">
          Search open projects and events by skill, then apply directly.
        </p>
      </div>
      <ProjectDirectory />
    </main>
  );
}
