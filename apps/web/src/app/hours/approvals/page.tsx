import { HoursApprovalQueue } from "@/components/hours-approval-queue";

export default function HoursApprovalsPage() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-[#faf8f3] p-16">
      <div className="flex w-full max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[#1a2a3a]">Hours approval queue</h1>
        <p className="text-sm text-[#1a2a3a]">
          Review pending hour entries across the projects you lead.
        </p>
      </div>
      <HoursApprovalQueue />
    </main>
  );
}
