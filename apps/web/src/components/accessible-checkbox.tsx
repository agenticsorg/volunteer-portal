"use client";

import * as Checkbox from "@radix-ui/react-checkbox";
import * as Label from "@radix-ui/react-label";

/**
 * A trivial page rendering with the chosen accessible-component library
 * (Radix UI, per ADR-0011), proving the toolchain works before any real
 * onboarding UI (Prompt 2.3's code-of-conduct / IP-agreement / age
 * attestation checkboxes) is built on top of it.
 */
export function AccessibleCheckbox() {
  return (
    <div className="flex items-center gap-2">
      <Checkbox.Root
        id="accessible-checkbox-demo"
        className="flex h-5 w-5 items-center justify-center rounded border border-input bg-background data-[state=checked]:bg-primary"
      >
        <Checkbox.Indicator className="text-primary-foreground">✓</Checkbox.Indicator>
      </Checkbox.Root>
      <Label.Root htmlFor="accessible-checkbox-demo" className="font-mono text-sm text-foreground">
        Radix UI accessible checkbox primitive
      </Label.Root>
    </div>
  );
}
