import { SiteHeader } from "@/components/site-header";
import { HoursApprovalQueue } from "@/components/hours-approval-queue";

export default function HoursApprovalsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center gap-8 px-6 py-16">
        <div className="flex w-full max-w-3xl flex-col gap-2">
          <h1 className="font-sans text-3xl font-semibold text-foreground">Hours approval queue</h1>
          <p className="font-mono text-sm text-secondary">
            Review pending hour entries across the projects you lead.
          </p>
        </div>
        <HoursApprovalQueue />
      </main>
    </div>
  );
}
