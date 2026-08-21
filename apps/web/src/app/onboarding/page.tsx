import { SiteHeader } from "@/components/site-header";
import { OnboardingForm } from "@/components/onboarding-form";

export default function OnboardingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center gap-8 px-6 py-16">
        <div className="flex w-full max-w-md flex-col gap-2">
          <h1 className="font-sans text-3xl font-semibold text-foreground">Complete your volunteer profile</h1>
          <p className="font-mono text-sm text-secondary">
            Tell us a bit about yourself and accept the agreements below to finish signing up.
          </p>
        </div>
        <OnboardingForm />
      </main>
    </div>
  );
}
