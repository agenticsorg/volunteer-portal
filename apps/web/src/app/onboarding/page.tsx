import { OnboardingForm } from "@/components/onboarding-form";

export default function OnboardingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-[#faf8f3] p-16">
      <div className="flex w-full max-w-md flex-col gap-2">
        <h1 className="text-2xl font-semibold text-[#1a2a3a]">Complete your volunteer profile</h1>
        <p className="text-sm text-[#1a2a3a]">
          Tell us a bit about yourself and accept the agreements below to finish signing up.
        </p>
      </div>
      <OnboardingForm />
    </main>
  );
}
